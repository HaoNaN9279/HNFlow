// HNFlow browser half, bundled with the capability surface.
//
// One module, two halves: the capability surface (agent picker, context
// inventory, model-layer settings and model seat) and the HNFlow surface
// (flow/run/inbox panels, session view, right tab and notice). They render
// into different slots and share the same routes.
//
// Both halves ride the ONE factory whose id equals the package name
// (`dsh-hnflow`): the Cordis Loader imports the module named after the package,
// so a factory registered under any other id is stored but never materialized.
// Splitting them under two ids silently drops whichever half does not match.

// Capability browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so
// no build step is involved.
//
// The picker occupies `conversation.input.left` — the compact control strip on
// the bottom-left of the composer — and opens its own menu above that strip.
// The menu is portalled to `document.body` and positioned from the trigger's
// viewport rect, so it is never clipped by the composer card.
//
// It renders only while the session runs the `capability` agent preset.
// Selecting an agent runs the mode's `/capability-agent <name>` command; the
// command log event is what the `capability` projection folds, so the choice
// survives a restart without any plugin-owned session event type.
function createCapabilityModule(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const reactDom = require("react-dom");
    const h = react.createElement;

    /** Services this client plugin consumes. */
    const inject = ["slots", "remote", "remote.commands", "remote.session", "sessions"];

    /**
     * The client context that owns the slot registration.
     *
     * Two Loader entries reference this package (the root UI row and the preset
     * row); the first one to mount owns the slot and later mounts are no-ops.
     */
    let owner = null;

    /** Menu ids stay unique per mounted picker (single React instance, no useId dependency). */
    let pickerSeq = 0;

    const styles = {
      root: { position: "relative", display: "inline-flex", alignItems: "center", maxWidth: "100%" },
      trigger: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        height: "28px",
        maxWidth: "200px",
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
        cursor: "pointer"
      },
      triggerOpen: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))" },
      triggerDisabled: { opacity: 0.6, cursor: "default" },
      glyph: { flex: "none", fontSize: "10px", lineHeight: "1", opacity: 0.8 },
      label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
      placeholder: { color: "var(--dsw-alias-label-tertiary, inherit)", fontWeight: 400 },
      caret: { flex: "none", fontSize: "9px", lineHeight: "1", opacity: 0.7 },
      menu: {
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        boxSizing: "border-box",
        overflowY: "auto",
        overscrollBehavior: "contain",
        padding: "4px",
        borderRadius: "var(--dsw-radius-lg, 12px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        background: "var(--dsw-specific-menu, var(--dsw-specific-input-major, #1f1f1f))",
        backdropFilter: "blur(40px) saturate(150%)",
        WebkitBackdropFilter: "blur(40px) saturate(150%)",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.28))",
        zIndex: 1100
      },
      menuHeader: {
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        padding: "5px 8px",
        marginBottom: "2px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))"
      },
      menuTitle: {
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: "var(--dsw-alias-label-caption, inherit)"
      },
      menuHint: { fontSize: "11px", lineHeight: "15px", color: "var(--dsw-alias-label-tertiary, inherit)" },
      item: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "6px 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: "13px",
        cursor: "pointer"
      },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))" },
      itemDisabled: { opacity: 0.45, cursor: "default" },
      check: {
        flex: "none",
        width: "14px",
        fontSize: "12px",
        lineHeight: "1",
        color: "var(--dsw-alias-state-business-primary, inherit)"
      },
      itemBody: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: "1 1 auto" },
      itemName: { fontWeight: 500, lineHeight: "18px" },
      itemGroup: {
        marginLeft: "6px",
        fontSize: "10px",
        fontWeight: 400,
        lineHeight: "14px",
        padding: "0 4px",
        borderRadius: "4px",
        color: "var(--dsw-alias-label-tertiary, inherit)",
        background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))"
      },
      itemDesc: {
        fontSize: "11px",
        lineHeight: "15px",
        color: "var(--dsw-alias-label-caption, inherit)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      },
      empty: {
        padding: "6px 8px 8px",
        fontSize: "12px",
        color: "var(--dsw-alias-label-tertiary, inherit)"
      }
    };

    /**
     * Place the portal menu against the trigger: above it when there is room,
     * otherwise below, always inside the viewport.
     * @param {HTMLElement} trigger - the picker button.
     * @returns {{position: string, left: string, top?: string, bottom?: string, width: string, maxHeight: string}} fixed style.
     */
    function placeMenu(trigger) {
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(320, Math.max(248, Math.round(rect.width) + 40));
      const left = Math.min(
        Math.max(margin, Math.round(rect.left) - 4),
        Math.max(margin, viewportWidth - width - margin)
      );
      const spaceAbove = Math.round(rect.top) - gap - margin;
      const spaceBelow = viewportHeight - Math.round(rect.bottom) - gap - margin;
      const upward = spaceAbove >= 180 || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(120, Math.min(320, upward ? spaceAbove : spaceBelow));
      const style = {
        position: "fixed",
        left: left + "px",
        width: width + "px",
        maxHeight: maxHeight + "px"
      };
      if (upward) style.bottom = viewportHeight - Math.round(rect.top) + gap + "px";
      else style.top = Math.round(rect.bottom) + gap + "px";
      return style;
    }

    /** Exact Fetch route owned by the host core row. */
    const LAYERS_PATH = "/api/capability/models";
    /** Read-only roster route used before the first pre-step publishes one. */
    const ROSTER_PATH = "/api/capability/roster";
    /** Idempotent workspace initialisation route owned by the host core row. */
    const PREPARE_PATH = "/api/capability/prepare";

    /**
     * Make a window's workspace ready for the HNFlow mode.
     *
     * Switching the preset must not leave the composer waiting: the host
     * creates `.hnflow/stack.json` when needed and resolves the plan once, so
     * the roster, the model layers and the preview all read a warm plan.
     * @param {string} sessionId - session id from the slot.
     * @param {string} [hint] - workspace directory the window belongs to.
     * @returns {Promise<object>} readiness report; never rejects on a failed resolve.
     */
    async function prepareWorkspace(sessionId, hint) {
      const query = new URLSearchParams({ sessionId });
      if (typeof hint === "string" && hint.length > 0) query.set("cwd", hint);
      const response = await fetch(PREPARE_PATH + "?" + query.toString(), {
        credentials: "same-origin",
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (payload.ready === undefined) {
        // The route is missing (older host) or answered an error envelope: stay
        // silent instead of claiming the workspace is unusable. The preview
        // still shows its own missing-plan error when that one is real.
        return { ready: null, cwd: hint || null, reason: "", warnings: [] };
      }
      return {
        ready: payload.ready === true,
        cwd: typeof payload.cwd === "string" ? payload.cwd : hint || null,
        project: typeof payload.project === "string" ? payload.project : "",
        created: payload.created === true,
        reason: typeof payload.reason === "string" ? payload.reason : "",
        warnings: Array.isArray(payload.warnings) ? payload.warnings : []
      };
    }

    /**
     * Read the roster for a session that has not published one yet.
     * @param {string} sessionId - session id from the slot.
     * @param {string} [hint] - workspace directory the window belongs to.
     * @returns {Promise<object | null>} roster payload or null.
     */
    async function readRoster(sessionId, hint) {
      const query = new URLSearchParams({ sessionId });
      if (typeof hint === "string" && hint.length > 0) query.set("cwd", hint);
      const response = await fetch(
        ROSTER_PATH + "?" + query.toString(),
        { credentials: "same-origin", cache: "no-store" }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) return null;
      return payload.roster ?? null;
    }

    /**
     * Read the model-layer document from the host route.
     * @returns {Promise<{layers: object[], default: string | null, warnings?: string[], catalog?: object}>} payload.
     */
    async function readLayerConfig() {
      const response = await fetch(LAYERS_PATH, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message ?? payload.code ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    /**
     * Write a model-layer document through the host route.
     * @param {{bindings: object, custom: object[], default: string | null}} document - proposed bindings.
     * @returns {Promise<object>} payload.
     */
    async function writeLayerConfig(document) {
      const response = await fetch(LAYERS_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(document)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const detail = payload.message ?? ((payload.warnings ?? []).join("; ") || `HTTP ${response.status}`);
        throw new Error(detail);
      }
      return payload;
    }

    /**
     * Derive the active layer from a session's model projection.
     *
     * Several default layers can share one route (all four default to
     * `deepseek-flash`), so a preferred id breaks the tie without hiding the
     * route-based fallback.

     * @param {object[]} layers - configured layers.
     * @param {object | undefined} selection - `{provider, model, reasoningEffort?}`.
     * @param {string | null} [preferredId] - layer to prefer when several match.
     * @returns {object | undefined} matching layer.
     */
    function activeLayer(layers, selection, preferredId = null) {
      if (!selection || typeof selection !== "object") return undefined;
      const matches = layers.filter(
        (layer) =>
          layer.bound !== false &&
          typeof layer.provider === "string" &&
          typeof layer.model === "string" &&
          layer.provider === selection.provider &&
          layer.model === selection.model &&
          (layer.reasoningEffort === undefined || layer.reasoningEffort === selection.reasoningEffort)
      );
      return matches.find((layer) => layer.id === preferredId) ?? matches[0];
    }


    /**
     * Settings page for model layers.
     * @param {{ctx?: object}} props - settings section props.
     * @returns {object} react element.
     */
    function LayerSettings(props) {
      const [layers, setLayers] = react.useState([]);
      const [defaultId, setDefaultId] = react.useState(null);
      const [draft, setDraft] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [message, setMessage] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [catalog, setCatalog] = react.useState(null);

      const load = react.useCallback(async () => {
        try {
          const payload = await readLayerConfig();
          setLayers(Array.isArray(payload.layers) ? payload.layers : []);
          setDefaultId(typeof payload.default === "string" ? payload.default : null);
          setCatalog(payload.catalog ?? null);
          setError(null);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, []);

      react.useEffect(() => {
        void load();
      }, [load]);

      const toCustom = (layer) => ({
        id: layer.id,
        label: layer.label,
        description: layer.description ?? "",
        provider: layer.provider,
        model: layer.model,
        ...(layer.reasoningEffort ? { reasoningEffort: layer.reasoningEffort } : {})
      });

      const snapshot = (overrideId = null) => {
        const custom = [];
        for (const layer of layers) {
          if (overrideId !== null && layer.id === overrideId) continue;
          if (layer.custom) custom.push(toCustom(layer));
        }
        return { custom };
      };

      const publish = async (nextCustom, nextDefault) => {
        setBusy(true);
        setMessage(null);
        setError(null);
        try {
          // Platform bindings stay owned by `.capability/models.json`; omitting
          // `bindings` asks the service to keep only explicit local overrides.
          const payload = await writeLayerConfig({
            custom: nextCustom,
            default: nextDefault
          });
          setLayers(Array.isArray(payload.layers) ? payload.layers : []);
          setDefaultId(typeof payload.default === "string" ? payload.default : null);
          setMessage("已保存");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const defaultFor = (custom, candidate) => {
        if (candidate === null) return null;
        // Undefined asks the service to keep the explicit local default (if
        // any) instead of pinning the project default into the local config.
        return custom.some((layer) => layer.id === candidate) ? candidate : undefined;
      };

      const save = async () => {
        if (draft === null || !draft.custom) return;
        const originalId = draft._originalId ?? draft.id;
        const { custom } = snapshot(originalId);
        if (!draft.id) {
          setError("自定义层需要 id");
          return;
        }
        custom.push(toCustom(draft));
        const nextDefault = defaultId === originalId ? draft.id : defaultId;
        await publish(custom, defaultFor(custom, nextDefault));
        setDraft(null);
      };

      const removeCustom = async (layer) => {
        const { custom } = snapshot(layer.id);
        await publish(custom, defaultFor(custom, defaultId === layer.id ? null : defaultId));
      };

      const makeDefault = async (layer) => {
        if (layer.bound === false || !layer.custom) return;
        const { custom } = snapshot();
        await publish(custom, defaultFor(custom, defaultId === layer.id ? null : layer.id));
      };

      const resetDefault = async () => {
        const { custom } = snapshot();
        await publish(custom, null);
      };

      const field = (key, placeholder, value, onInput, type = "text") =>
        h("input", {
          type,
          value: value ?? "",
          placeholder,
          onChange: (event) => onInput(event.target.value),
          style: {
            boxSizing: "border-box",
            width: "100%",
            padding: "7px 9px",
            borderRadius: "var(--dsw-radius-sm, 6px)",
            border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
            background: "transparent",
            color: "inherit",
            fontFamily: "inherit",
            fontSize: "13px"
          }
        });

      const rowStyle = {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 0",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))"
      };

      const routeOf = (layer) => layer.bound === false
        ? "未绑定本机模型"
        : `${layer.provider}/${layer.model}${layer.reasoningEffort ? " · " + layer.reasoningEffort : ""}`;
      const customDefault = layers.some((layer) => layer.custom && layer.id === defaultId);

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0 20px" } },
        h("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, inherit)", lineHeight: "19px" } },
          "四个平台层由项目 .capability/models.json 提供，此处只读显示，默认层也由项目配置决定。本页只管理仅 DSH 可用的自定义层；能力组只写 model: <layer>。"),
        error ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #d33)", fontSize: "12px" } }, error) : null,
        message ? h("div", { style: { color: "var(--dsw-alias-state-success-primary, #2a7)", fontSize: "12px" } }, message) : null,
        catalog && !catalog.error
          ? h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)" } },
              `路由检测：${(catalog.available ?? []).length} 可用，${(catalog.unroutable ?? []).length} 不可用` +
                ((catalog.unroutable ?? []).length === 0
                  ? ""
                  : " · " + (catalog.unroutable ?? []).map((layer) => `${layer.id}: ${layer.reason}`).join("; ")))
          : null,
        layers.length === 0
          ? h("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, inherit)" } }, "模型层目录不可用（检查 hnflow-stack 安装与版本）。")
          : h("div", null, layers.map((layer) => {
              const readOnly = !layer.custom;
              return h("div", {
                key: layer.id,
                style: readOnly
                  ? Object.assign({}, rowStyle, { opacity: 0.55 })
                  : rowStyle
              },
                h("button", {
                  type: "button",
                  title: readOnly
                    ? "平台层默认由项目配置决定"
                    : layer.bound === false ? "未绑定，不能设为默认层" : "设为默认层",
                  disabled: readOnly || layer.bound === false || busy,
                  onClick: () => void makeDefault(layer),
                  style: {
                    flex: "none",
                    width: "20px",
                    height: "20px",
                    borderRadius: "50%",
                    border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.4))",
                    background: defaultId === layer.id ? "var(--dsw-alias-state-business-primary, #4a7)" : "transparent",
                    color: "transparent",
                    cursor: readOnly || layer.bound === false ? "default" : "pointer"
                  }
                }, "•"),
                h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, flex: "1 1 auto" } },
                  h("span", { style: { fontSize: "13px", fontWeight: 500 } },
                    `${layer.label} (${layer.id})${layer.custom ? " · 自定义" : " · 平台"}`),
                  h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" } },
                    `${routeOf(layer)}${defaultId === layer.id ? " · 默认" : ""}`)
                ),
                readOnly
                  ? h("span", { style: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" } }, "项目配置")
                  : h(react.Fragment, null,
                      h("button", { type: "button", onClick: () => setDraft({ ...layer, _originalId: layer.id }), style: smallButton }, "编辑"),
                      h("button", { type: "button", disabled: busy, onClick: () => void removeCustom(layer), style: smallButton }, "删除")
                    )
              );
            })),
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          h("button", {
            type: "button",
            onClick: () => setDraft({ id: "", label: "", description: "", provider: "", model: "", reasoningEffort: "", custom: true }),
            style: primaryButton
          }, "新增自定义层（仅 DSH）"),
          customDefault
            ? h("button", { type: "button", disabled: busy, onClick: () => void resetDefault(), style: smallButton }, "恢复项目默认层")
            : null,
          h("button", { type: "button", onClick: () => void load(), style: smallButton }, "检测路由 / 重新读取")
        ),
        draft === null
          ? null
          : h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px", borderRadius: "var(--dsw-radius-md, 10px)", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))" } },
              h("div", { style: { fontSize: "12px", fontWeight: 600 } },
                draft.custom ? "自定义层（仅 DSH）" : `平台层绑定：${draft.id}`),
              draft.custom
                ? h(react.Fragment, null,
                    field("id", "id（小写 kebab，如 my-fast）", draft.id, (value) => setDraft({ ...draft, id: value })),
                    field("label", "显示名", draft.label, (value) => setDraft({ ...draft, label: value })),
                    field("description", "说明（可选）", draft.description, (value) => setDraft({ ...draft, description: value })))
                : h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" } },
                    `${draft.label} · 平台层 id 与名称不可修改`),
              field("provider", "provider（如 deepseek-account）", draft.provider, (value) => setDraft({ ...draft, provider: value })),
              field("model", "model（如 deepseek-flash）", draft.model, (value) => setDraft({ ...draft, model: value })),
              field("reasoningEffort", "reasoningEffort（可选）", draft.reasoningEffort, (value) => setDraft({ ...draft, reasoningEffort: value })),
              h("div", { style: { display: "flex", gap: "8px" } },
                h("button", { type: "button", disabled: busy, onClick: () => void save(), style: primaryButton }, busy ? "保存中…" : "保存"),
                h("button", { type: "button", disabled: busy, onClick: () => setDraft(null), style: smallButton }, "取消")
              )
            )
      );
    }

    /**
     * Opt-in replacement for the composer model seat.
     *
     * Only registered when `modelSelector: replace` is configured. For
     * Capability sessions it lists layers; for other modes it falls back to the
     * live native catalog so replacing the seat never removes model choice.
     * @param {{useProjection: Function, available: boolean, directory: object, load: Function, select: Function}} props - slot props.
     * @returns {object | null} react element or null for addressed subagents.
     */
    function ModelSeat(props) {
      const preset = props.useProjection("agentPreset");
      const subscribe = react.useCallback(
        (callback) => (props.directory ? props.directory.subscribe(callback) : () => {}),
        [props.directory]
      );
      const getSnapshot = react.useCallback(
        () => (props.directory ? props.directory.getSnapshot() : null),
        [props.directory]
      );
      const snapshot = react.useSyncExternalStore(subscribe, getSnapshot);
      const [layers, setLayers] = react.useState([]);
      const [defaultLayerId, setDefaultLayerId] = react.useState(null);
      const [selectedLayerId, setSelectedLayerId] = react.useState(null);
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [active, setActive] = react.useState(0);
      const [pos, setPos] = react.useState(null);
      const triggerRef = react.useRef(null);
      const menuRef = react.useRef(null);
      const idRef = react.useRef(null);
      const restoreFocus = react.useRef(false);

      if (idRef.current === null) {
        pickerSeq += 1;
        idRef.current = "capability-model-menu-" + pickerSeq;
      }

      const isCapability = preset === "hnflow";
      const current = snapshot && snapshot.current ? snapshot.current : null;
      const groups = snapshot && Array.isArray(snapshot.groups) ? snapshot.groups : [];
      const storageKey = typeof props.sessionId === "string" && props.sessionId.length > 0
        ? `capability:selected-layer:${props.sessionId}`
        : null;
      const remembered = layers.find((entry) => entry.id === selectedLayerId && entry.bound !== false);
      const rememberedMatches = remembered !== undefined &&
        current !== null &&
        remembered.provider === current.provider &&
        remembered.model === current.model &&
        (remembered.reasoningEffort ?? "") === (current.reasoningEffort ?? "");
      const layer = isCapability
        ? (rememberedMatches ? remembered : activeLayer(layers, current, defaultLayerId))
        : undefined;

      const remember = react.useCallback((id) => {
        setSelectedLayerId(id);
        if (storageKey === null) return;
        try {
          if (id === null) window.sessionStorage.removeItem(storageKey);
          else window.sessionStorage.setItem(storageKey, id);
        } catch {
          // Storage can be unavailable in hardened browser contexts.
        }
      }, [storageKey]);

      react.useEffect(() => {
        if (!isCapability || storageKey === null) {
          setSelectedLayerId(null);
          return;
        }
        try {
          setSelectedLayerId(window.sessionStorage.getItem(storageKey));
        } catch {
          setSelectedLayerId(null);
        }
      }, [isCapability, storageKey]);

      react.useEffect(() => {
        if (!props.available) return;
        props.load?.();
        if (!isCapability) return;
        let alive = true;
        readLayerConfig()
          .then((payload) => {
            if (!alive) return;
            setLayers(Array.isArray(payload.layers) ? payload.layers : []);
            setDefaultLayerId(typeof payload.default === "string" ? payload.default : null);
          })
          .catch(() => {
            if (alive) setLayers([]);
          });
        return () => {
          alive = false;
        };
      }, [props.available, isCapability, props.load]);

      const measure = react.useCallback(() => {
        if (triggerRef.current) setPos(placeMenu(triggerRef.current));
      }, []);

      react.useEffect(() => {
        if (!open) {
          setPos(null);
          return undefined;
        }
        measure();
        const onViewportChange = () => measure();
        window.addEventListener("resize", onViewportChange);
        window.addEventListener("scroll", onViewportChange, true);
        return () => {
          window.removeEventListener("resize", onViewportChange);
          window.removeEventListener("scroll", onViewportChange, true);
        };
      }, [open, measure]);

      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (menuRef.current && menuRef.current.contains(target)) return;
          if (triggerRef.current && triggerRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key !== "Escape") return;
          setOpen(false);
          triggerRef.current?.focus?.();
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      react.useEffect(() => {
        if (busy) {
          setOpen(false);
          return;
        }
        if (!restoreFocus.current) return;
        restoreFocus.current = false;
        triggerRef.current?.focus?.();
      }, [busy]);

      if (!props.available) return null;

      const nativeNames = new Map();
      for (const group of groups) {
        for (const model of group.models ?? []) nativeNames.set(`${group.id}/${model.id}`, model.name);
      }
      const nativeOptions = groups.flatMap((group) =>
        (group.models ?? []).map((model) => ({
          key: `${group.id}/${model.id}`,
          label: model.name,
          detail: isCapability ? `跟随 DSH · ${group.name}` : group.name,
          selected: layer === undefined && current !== null && current.provider === group.id && current.model === model.id,
          selection: { provider: group.id, model: model.id }
        }))
      );
      const layerOptions = layers.map((entry) => ({
        key: entry.id,
        layerId: entry.id,
        label: entry.label,
        detail: entry.bound === false
          ? "未绑定本机模型"
          : `${entry.provider}/${entry.model}${entry.reasoningEffort ? " · " + entry.reasoningEffort : ""}`,
        selected: layer !== undefined && layer.id === entry.id,
        disabled: entry.bound === false,
        selection: entry.bound === false
          ? undefined
          : {
              provider: entry.provider,
              model: entry.model,
              ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort })
            }
      }));
      const options = isCapability ? layerOptions.concat(nativeOptions) : nativeOptions;
      const nativeName = current ? nativeNames.get(`${current.provider}/${current.model}`) : undefined;
      const label = isCapability
        ? layer?.label ?? nativeName ?? (current ? "未映射" : "模型层")
        : nativeName ?? current?.model ?? "选择模型";

      const choose = async (option) => {
        if (busy || option.selected || option.disabled) {
          setOpen(false);
          return;
        }
        restoreFocus.current = true;
        setBusy(true);
        try {
          if (option.layerId && typeof props.selectLayer === "function") {
            // Apply by layer id instead of provider/model: the four default
            // layers can share one route, so only the command can tell them
            // apart.
            const result = await props.selectLayer(option.layerId);
            if (result && result.ok === false) {
              throw new Error(`${result.error?.code ?? "layer-unavailable"}: ${result.error?.message ?? ""}`);
            }
            remember(option.layerId);
          } else {
            const result = await props.select(option.selection);
            if (result && result.ok === false) {
              throw new Error(`${result.error?.code ?? "model-unavailable"}: ${result.error?.message ?? ""}`);
            }
            remember(null);
          }
        } catch (failure) {
          console.warn("[capability] model selection failed", failure);
        } finally {
          setBusy(false);
        }
      };

      const onKeyDown = (event) => {
        if (!open || options.length === 0) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((index) => (index + 1) % options.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => (index - 1 + options.length) % options.length);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const option = options[active];
          if (option !== undefined) void choose(option);
        }
      };

      const trigger = h(
        "button",
        {
          type: "button",
          ref: triggerRef,
          style: open
            ? Object.assign({}, styles.trigger, styles.triggerOpen)
            : busy
              ? Object.assign({}, styles.trigger, styles.triggerDisabled)
              : styles.trigger,
          title: isCapability ? `模型层：${label}` : `模型：${label}`,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? idRef.current : undefined,
          "aria-label": label,
          "aria-busy": busy,
          disabled: busy,
          onClick: () => {
            if (open) {
              setOpen(false);
              return;
            }
            measure();
            setOpen(true);
          }
        },
        h("span", { style: styles.glyph, "aria-hidden": true }, "◇"),
        h("span", { style: styles.label }, busy ? "切换中…" : label),
        h("span", { style: styles.caret, "aria-hidden": true }, "▾")
      );

      const menu =
        open && pos !== null
          ? reactDom.createPortal(
              h(
                "div",
                {
                  ref: menuRef,
                  id: idRef.current,
                  role: "menu",
                  "aria-label": isCapability ? "模型层" : "模型",
                  style: Object.assign({}, styles.menu, pos)
                },
                h(
                  "div",
                  { style: styles.menuHeader },
                  h("span", { style: styles.menuTitle }, isCapability ? "模型层" : "模型"),
                  h("span", { style: styles.menuHint }, isCapability ? "用户级路由；不改变权限或工具" : "跟随 DSH 模型目录")
                ),
                options.length === 0
                  ? h("span", { style: styles.empty }, isCapability ? "未配置模型层" : "没有可用模型")
                  : options.map((option, index) =>
                      h(
                        "button",
                        {
                          key: option.key,
                          type: "button",
                          role: "menuitemradio",
                          "aria-checked": option.selected,
                          "aria-disabled": option.disabled === true,
                          tabIndex: -1,
                          style: Object.assign(
                            {},
                            styles.item,
                            option.disabled ? { opacity: 0.5, cursor: "default" } : {},
                            index === active ? styles.itemActive : {}
                          ),
                          onMouseEnter: () => setActive(index),
                          onClick: () => void choose(option)
                        },
                        h("span", { style: styles.check, "aria-hidden": true }, option.selected ? "✓" : ""),
                        h(
                          "span",
                          { style: styles.itemBody },
                          h("span", { style: styles.itemName }, option.label),
                          h("span", { style: styles.itemDesc }, option.detail)
                        )
                      )
                    )
              ),
              document.body
            )
          : null;

      return h(
        react.Fragment,
        null,
        h("div", { style: styles.root, onKeyDown }, trigger),
        menu
      );
    }

    const smallButton = {
      flex: "none",
      padding: "5px 9px",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary, inherit)",
      fontFamily: "inherit",
      fontSize: "12px",
      cursor: "pointer"
    };
    const primaryButton = Object.assign({}, smallButton, {
      background: "var(--dsw-alias-state-business-primary, #3a6df0)",
      borderColor: "transparent",
      color: "#fff"
    });

    /**
     * Bottom-left agent menu for the HNFlow mode.
     * @param {{useProjection: Function, onSelect: (name: string) => Promise<void>}} props - slot props.
     * @returns {object | null} react element or null outside the mode.
     */
    function AgentPicker(props) {
      const state = props.useProjection("capability");
      const preset = props.useProjection("agentPreset");
      const [fallback, setFallback] = react.useState(null);
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [active, setActive] = react.useState(0);
      const [pos, setPos] = react.useState(null);
      const [attempt, setAttempt] = react.useState(0);
      const rootRef = react.useRef(null);
      const triggerRef = react.useRef(null);
      const menuRef = react.useRef(null);
      const idRef = react.useRef(null);
      const restoreFocus = react.useRef(false);
      const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";

      if (idRef.current === null) {
        pickerSeq += 1;
        idRef.current = "capability-agent-menu-" + pickerSeq;
      }

      const projectionRoster = state && Array.isArray(state.agents) ? state.agents : [];
      const sessionsSnapshot = useOptionalSnapshot(props.useSessions);
      const workspacesSnapshot = useOptionalSnapshot(props.useWorkspaces);
      const projectedCwd = inventoryCwdHint(sessionsSnapshot, workspacesSnapshot, sessionId);
      const cwdHint = projectedCwd.length > 0
        ? projectedCwd
        : sessionCwdHint(props.sessionsService, sessionId);

      // A blank session has no stored roster yet: the on-disk format forbids
      // any surface event before the first system/message, so the host serves
      // the pre-turn roster through a read-only route instead. A session that
      // was just switched to the mode has no resolved plan either, so the
      // window's workspace is initialised first and the roster read second.
      react.useEffect(() => {
        if (preset !== "hnflow" || sessionId.length === 0 || projectionRoster.length > 0) {
          setFallback(null);
          return undefined;
        }
        let cancelled = false;
        prepareWorkspace(sessionId, cwdHint)
          .catch(() => null)
          .then((report) => (cancelled ? null : readRoster(sessionId, cwdHint)))
          .then((next) => {
            if (!cancelled) setFallback(next);
          })
          .catch(() => {
            if (!cancelled) setFallback(null);
          });
        return () => {
          cancelled = true;
        };
      }, [preset, sessionId, projectionRoster.length, cwdHint, attempt]);

      const roster = projectionRoster.length > 0
        ? projectionRoster
        : fallback && Array.isArray(fallback.agents)
          ? fallback.agents
          : [];
      // subagent-only definitions stay in the roster but not in the persona menu.
      const agents = roster.filter((agent) => agent && agent.mode !== "subagent");
      const canonical = (name) => {
        if (typeof name !== "string" || name.length === 0) return null;
        const found = agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
        return found === undefined ? null : found.name;
      };
      const selected =
        canonical(state && state.selected) ??
        canonical(fallback && fallback.defaultSelected);
      // The picker is part of the mode, not of the roster: a workspace whose
      // plan is still missing must show the control (with a retry) instead of
      // silently deleting it from the composer.
      const visible = preset === "hnflow";
      const empty = agents.length === 0;

      const measure = react.useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        setPos(placeMenu(trigger));
      }, []);

      // Keep the highlighted row on the current persona whenever the menu opens.
      react.useEffect(() => {
        if (!open) return;
        const index = selected === null ? 0 : agents.findIndex((agent) => agent.name === selected);
        setActive(index < 0 ? 0 : index);
      }, [open, selected, agents.length]);

      // Follow the trigger while the composer or the window changes size.
      react.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return undefined;
        }
        measure();
        const onViewportChange = () => measure();
        window.addEventListener("resize", onViewportChange);
        window.addEventListener("scroll", onViewportChange, true);
        return () => {
          window.removeEventListener("resize", onViewportChange);
          window.removeEventListener("scroll", onViewportChange, true);
        };
      }, [open, measure]);

      // Outside click / Escape closes the menu (the portal is outside the root).
      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          const root = rootRef.current;
          const menu = menuRef.current;
          if (root && root.contains(target)) return;
          if (menu && menu.contains(target)) return;
          setOpen(false);
        };
        const onDocumentKeyDown = (event) => {
          if (event.key !== "Escape") return;
          setOpen(false);
          const trigger = triggerRef.current;
          if (trigger && typeof trigger.focus === "function") trigger.focus();
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onDocumentKeyDown);
        return () => {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onDocumentKeyDown);
        };
      }, [open]);

      // A selection closes the menu; the trigger keeps the pending state until
      // the host acknowledges the command, then takes focus back.
      react.useEffect(() => {
        if (busy) {
          setOpen(false);
          return;
        }
        if (!restoreFocus.current) return;
        restoreFocus.current = false;
        const trigger = triggerRef.current;
        if (trigger && typeof trigger.focus === "function") trigger.focus();
      }, [busy]);

      if (!visible) return null;

      const choose = async (name) => {
        if (busy || name === selected) {
          setOpen(false);
          return;
        }
        restoreFocus.current = true;
        setBusy(true);
        try {
          await props.onSelect(name);
        } catch (error) {
          console.warn("[capability] agent selection failed", error);
        } finally {
          setBusy(false);
        }
      };

      const onKeyDown = (event) => {
        if (!open || agents.length === 0) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((index) => (index + 1) % agents.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => (index - 1 + agents.length) % agents.length);
        } else if (event.key === "Home") {
          event.preventDefault();
          setActive(0);
        } else if (event.key === "End") {
          event.preventDefault();
          setActive(agents.length - 1);
        } else if (event.key === "Enter" || event.key === " ") {
          const agent = agents[active];
          if (agent === undefined) return;
          event.preventDefault();
          void choose(agent.name);
        }
      };

      const label = selected === null ? "选择 Agent" : selected;

      const trigger = h(
        "button",
        {
          type: "button",
          ref: triggerRef,
          style: open
            ? Object.assign({}, styles.trigger, styles.triggerOpen)
            : busy
              ? Object.assign({}, styles.trigger, styles.triggerDisabled)
              : styles.trigger,
          title:
            empty
              ? "HNFlow Agent：工作区计划尚未就绪，点击重试"
              : selected === null
                ? "HNFlow Agent：未选择人设，点击选择"
                : `HNFlow Agent：${selected}（本会话人设）`,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? idRef.current : undefined,
          "aria-label": `HNFlow Agent：${label}`,
          "aria-busy": busy,
          disabled: busy,
          onClick: () => {
            if (open) {
              setOpen(false);
              return;
            }
            if (empty) {
              // No roster yet: re-run the prepare/roster pair instead of
              // opening an empty menu.
              setAttempt((count) => count + 1);
              return;
            }
            measure();
            setOpen(true);
          }
        },
        h("span", { style: styles.glyph, "aria-hidden": true }, "◆"),
        h(
          "span",
          { style: selected === null ? Object.assign({}, styles.label, styles.placeholder) : styles.label },
          busy ? "切换中…" : label
        ),
        h("span", { style: styles.caret, "aria-hidden": true }, "▾")
      );

      const menu =
        open && pos !== null && agents.length > 0
          ? reactDom.createPortal(
              h(
                "div",
                {
                  ref: menuRef,
                  id: idRef.current,
                  role: "menu",
                  "aria-label": "HNFlow Agent",
                  style: Object.assign({}, styles.menu, pos)
                },
                h(
                  "div",
                  { style: styles.menuHeader },
                  h("span", { style: styles.menuTitle }, "Agent"),
                  h("span", { style: styles.menuHint }, "Core + 当前工作区能力组的并集；切换只影响本会话人设")
                ),
                agents.map((agent, index) =>
                  h(
                    "button",
                    {
                      key: agent.name,
                      type: "button",
                      role: "menuitemradio",
                      "aria-checked": agent.name === selected,
                      tabIndex: -1,
                      style: index === active ? Object.assign({}, styles.item, styles.itemActive) : styles.item,
                      onMouseEnter: () => setActive(index),
                      onClick: () => void choose(agent.name)
                    },
                    h("span", { style: styles.check, "aria-hidden": true }, agent.name === selected ? "✓" : ""),
                    h(
                      "span",
                      { style: styles.itemBody },
                      h(
                        "span",
                        { style: styles.itemName },
                        agent.name,
                        agent.group ? h("span", { style: styles.itemGroup }, agent.group) : null
                      ),
                      agent.description ? h("span", { style: styles.itemDesc }, agent.description) : null
                    )
                  )
                )
              ),
              document.body
            )
          : null;

      return h(
        react.Fragment,
        null,
        h(
          "div",
          {
            ref: rootRef,
            style: styles.root,
            "data-capability-agent-picker": selected === null ? "" : selected,
            onKeyDown
          },
          trigger
        ),
        menu
      );
    }

/** Fetch route that lists what the current session loads. */
const INVENTORY_PATH = "/api/capability/inventory";
/** Fetch route that returns one inventory entry's full text. */
const INVENTORY_TEXT_PATH = "/api/capability/inventory/text";

/** Status glyphs shared with `hnflow-stack preview`. */
const INVENTORY_STATUS = {
  injected: { mark: "+", label: "已注入" },
  indexed: { mark: "~", label: "仅索引" },
  omitted: { mark: "!", label: "超预算" },
  skipped: { mark: "-", label: "未加载" },
  active: { mark: "*", label: "生效" }
};

/**
 * Read a slot snapshot hook without letting an absent hook break the panel.
 *
 * The composer slot always hands us `useSessions` and `useWorkspaces`; a plain
 * unit test or an older host may not, so the call is defensive. The hook is
 * called in the same order on every render of this component.
 * @param {Function | undefined} hook - snapshot selector hook.
 * @returns {any} the snapshot, or null.
 */
function useOptionalSnapshot(hook) {
  if (typeof hook !== "function") return null;
  try {
    return hook((snapshot) => snapshot);
  } catch {
    return null;
  }
}

/**
 * Collect the session summaries out of a sessions snapshot.
 *
 * The client keeps the list as `{phase, ids, byId}`; older or plain fixtures
 * hand back an array, `.items` or `.sessions`. All three shapes are accepted.
 * @param {any} snapshot - sessions snapshot.
 * @returns {Array<object>} summaries.
 */
function sessionSummaries(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return [];
  if (Array.isArray(snapshot)) return snapshot;
  const items = snapshot.items ?? snapshot.sessions;
  if (Array.isArray(items)) return items;
  if (Array.isArray(snapshot.ids) && snapshot.byId !== null && typeof snapshot.byId === "object") {
    return snapshot.ids.map((id) => snapshot.byId[id]).filter((entry) => entry !== undefined);
  }
  const table = snapshot.byId;
  return table !== null && typeof table === "object" ? Object.values(table) : [];
}

/**
 * Collect the workspace records out of a workspaces snapshot.
 *
 * The client exposes `{phase, items, archivedSessionIds}`; each item carries
 * `workspaceId`, `path` and `sessionIds`. Array, `.workspaces` and `.byId`
 * fixtures are accepted too.
 * @param {any} snapshot - workspaces snapshot.
 * @returns {Array<object>} workspaces.
 */
function workspaceRecords(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return [];
  if (Array.isArray(snapshot)) return snapshot;
  const items = snapshot.items ?? snapshot.workspaces;
  if (Array.isArray(items)) return items;
  const table = snapshot.byId;
  return table !== null && typeof table === "object" ? Object.values(table) : [];
}

/**
 * Pick the directory a brand-new window belongs to.
 *
 * A window that has not sent a prompt yet has no host session, so the server
 * cannot know its workspace. The client does: a blank session summary carries
 * `cwd`, and the workspace record lists the path of every workspace that owns
 * the session. Only values the client can actually observe are used; when none
 * exists the server keeps its own fallbacks.
 * @param {any} sessions - sessions snapshot.
 * @param {any} workspaces - workspaces snapshot.
 * @param {string} sessionId - window session id.
 * @returns {string} absolute directory, or an empty string.
 */
function inventoryCwdHint(sessions, workspaces, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "";
  for (const entry of sessionSummaries(sessions)) {
    if (entry === null || typeof entry !== "object") continue;
    const id = typeof entry.sessionId === "string" ? entry.sessionId : entry.id;
    if (id !== sessionId) continue;
    if (typeof entry.cwd === "string" && entry.cwd.length > 0) return entry.cwd;
    const projected = entry.projectionValues?.workingDirectory;
    if (typeof projected === "string" && projected.length > 0) return projected;
  }
  const records = workspaceRecords(workspaces);
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    const owned = Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId);
    if (owned && typeof record.path === "string" && record.path.length > 0) return record.path;
  }
  return "";
}

/**
 * Workspace directory of one session, read from the live session service.
 *
 * The composer slot hands only `sessionId` to a left-strip control, so the
 * snapshot hooks the panel accepts are not always available. The sessions
 * service the plugin already injects carries the same summaries, which keeps
 * the workspace hint alive for a brand-new window.
 * @param {any} sessions - injectable client sessions service.
 * @param {string} sessionId - window session id.
 * @returns {string} absolute directory, or an empty string.
 */
function sessionCwdHint(sessions, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "";
  try {
    const list = sessions && sessions.list;
    const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
    return inventoryCwdHint(snapshot, null, sessionId);
  } catch {
    return "";
  }
}

/**
 * Read the session inventory.
 * @param {string} sessionId - live session id.
 * @param {string} agent - selected persona name, or an empty string.
 * @param {string} [hint] - workspace directory the window belongs to.
 * @returns {Promise<object>} inventory payload.
 */
async function readInventory(sessionId, agent, hint) {
  const query = new URLSearchParams({ sessionId });
  if (typeof agent === "string" && agent.length > 0) query.set("agent", agent);
  if (typeof hint === "string" && hint.length > 0) query.set("cwd", hint);
  const response = await fetch(`${INVENTORY_PATH}?${query.toString()}`, {
    credentials: "same-origin",
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message ?? payload.code ?? `HTTP ${response.status}`);
  }
  return payload.inventory ?? null;
}

/**
 * Read one inventory entry's full text.
 * @param {string} sessionId - live session id.
 * @param {string} kind - entry kind.
 * @param {string} id - entry id.
 * @param {string} [hint] - workspace directory the window belongs to.
 * @returns {Promise<{text: string, truncated: boolean, path: string}>} preview payload.
 */
async function readInventoryText(sessionId, kind, id, hint) {
  const query = new URLSearchParams({ sessionId, kind, id });
  if (typeof hint === "string" && hint.length > 0) query.set("cwd", hint);
  const response = await fetch(`${INVENTORY_TEXT_PATH}?${query.toString()}`, {
    credentials: "same-origin",
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message ?? payload.code ?? `HTTP ${response.status}`);
  }
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    truncated: payload.truncated === true,
    path: typeof payload.path === "string" ? payload.path : ""
  };
}

/**
 * Copy text to the clipboard, tolerating a denied clipboard permission.
 * @param {string} text - text to copy.
 * @returns {Promise<boolean>} whether the copy succeeded.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Styles for the inventory button, dialog and hover card. */
const inventoryStyles = {
  button: {
    flex: "none",
    width: "28px",
    height: "28px",
    padding: "0",
    borderRadius: "var(--dsw-radius-sm, 6px)",
    border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
    background: "transparent",
    color: "var(--dsw-alias-label-secondary, inherit)",
    fontFamily: "inherit",
    fontSize: "13px",
    lineHeight: "1",
    cursor: "pointer"
  },
  overlay: {
    position: "fixed",
    inset: "0",
    zIndex: 70,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.42))",
    backdropFilter: "var(--dsw-mask-blur, blur(4px))",
    WebkitBackdropFilter: "var(--dsw-mask-blur, blur(4px))"
  },
  dialog: {
    display: "flex",
    flexDirection: "column",
    width: "min(940px, 92vw)",
    maxHeight: "86vh",
    borderRadius: "var(--dsw-radius-lg, 12px)",
    border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
    background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #1f1f1f))",
    backdropFilter: "var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))",
    WebkitBackdropFilter: "var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))",
    color: "var(--dsw-alias-label-primary, inherit)",
    boxShadow: "var(--dsw-elevation-panel, 0 18px 48px rgba(0,0,0,0.28))",
    overflow: "hidden"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "12px 14px",
    borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))"
  },
  title: { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
  subtitle: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  spacer: { flex: "1 1 auto" },
  body: { flex: "1 1 auto", overflow: "auto", padding: "6px 10px 14px" },
  section: { marginTop: "10px" },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 4px",
    border: "none",
    background: "transparent",
    color: "var(--dsw-alias-label-secondary, inherit)",
    fontFamily: "inherit",
    fontSize: "12px",
    fontWeight: 600,
    textAlign: "left",
    cursor: "pointer"
  },
  count: { fontWeight: 400, color: "var(--dsw-alias-label-tertiary, inherit)" },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    padding: "6px 4px",
    borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.1))"
  },
  mark: { flex: "none", width: "14px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)" },
  rowBody: { flex: "1 1 auto", minWidth: "0" },
  rowName: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
  rowMeta: { marginTop: "2px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowSummary: { marginTop: "2px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, inherit)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  previewButton: {
    flex: "none",
    width: "24px",
    height: "24px",
    padding: "0",
    borderRadius: "var(--dsw-radius-sm, 6px)",
    border: "1px solid transparent",
    background: "transparent",
    color: "var(--dsw-alias-label-secondary, inherit)",
    fontFamily: "inherit",
    fontSize: "12px",
    cursor: "pointer"
  },
  muted: { padding: "14px 6px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)" },
  error: { padding: "14px 6px", fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #c0392b)" },
  warning: {
    padding: "10px 12px",
    margin: "0 0 10px",
    borderRadius: "var(--dsw-radius-sm, 6px)",
    border: "1px solid var(--dsw-alias-state-warning-border, rgba(214,158,46,0.42))",
    background: "var(--dsw-alias-state-warning-bg, rgba(214,158,46,0.12))",
    fontSize: "12px",
    lineHeight: "1.5",
    color: "var(--dsw-alias-label-primary, inherit)"
  },
  card: {
    position: "fixed",
    zIndex: 71,
    display: "flex",
    flexDirection: "column",
    width: "min(560px, 92vw)",
    maxHeight: "70vh",
    borderRadius: "var(--dsw-radius-lg, 10px)",
    border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))",
    background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #1f1f1f))",
    backdropFilter: "var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))",
    WebkitBackdropFilter: "var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))",
    color: "var(--dsw-alias-label-primary, inherit)",
    boxShadow: "var(--dsw-elevation-panel, 0 14px 36px rgba(0,0,0,0.24))",
    overflow: "hidden"
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 10px",
    borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))"
  },
  cardTitle: { flex: "1 1 auto", minWidth: "0", fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardBody: { flex: "1 1 auto", overflow: "auto", padding: "10px 12px" },
  pre: {
    margin: "0",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.55",
    color: "var(--dsw-alias-label-primary, inherit)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word"
  },
  cardFoot: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 10px",
    borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))",
    fontSize: "11px",
    color: "var(--dsw-alias-label-tertiary, inherit)"
  }
};

/**
 * Position the hover card beside an icon without leaving the viewport.
 * @param {DOMRect} rect - preview icon rect.
 * @returns {{left: string, top: string}} fixed offsets.
 */
function placeInventoryCard(rect) {
  const margin = 10;
  const width = Math.min(560, window.innerWidth * 0.92);
  const height = Math.min(window.innerHeight * 0.7, 420);
  let left = rect.right + margin;
  if (left + width > window.innerWidth - margin) left = rect.left - width - margin;
  if (left < margin) left = margin;
  let top = rect.top;
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  if (top < margin) top = margin;
  return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
}

/**
 * Error boundary: a broken panel must never take the composer down.
 */
class InventoryBoundary extends react.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn("[capability] inventory panel failed", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Small button next to the Agent picker that opens the session inventory.
 * @param {{useProjection: Function, sessionId?: string}} props - slot props.
 * @returns {object | null} react element, or null outside the mode.
 */
function InventoryPanel(props) {
  const preset = props.useProjection("agentPreset");
  const sessionState = props.useProjection("capability");
  const sessionsSnapshot = useOptionalSnapshot(props.useSessions);
  const workspacesSnapshot = useOptionalSnapshot(props.useWorkspaces);
  const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
  const projectedCwd = inventoryCwdHint(sessionsSnapshot, workspacesSnapshot, sessionId);
  const cwdHint = projectedCwd.length > 0
    ? projectedCwd
    : sessionCwdHint(props.sessionsService, sessionId);
  const [open, setOpen] = react.useState(false);
  const [data, setData] = react.useState(null);
  const [error, setError] = react.useState("");
  const [loading, setLoading] = react.useState(false);
  const [collapsed, setCollapsed] = react.useState({});
  const [hover, setHover] = react.useState(null);
  const [preview, setPreview] = react.useState(null);
  const [copied, setCopied] = react.useState("");
  const [readiness, setReadiness] = react.useState(null);
  const cacheRef = react.useRef(new Map());
  const showTimer = react.useRef(null);
  const hideTimer = react.useRef(null);
  const dialogRef = react.useRef(null);
  const selected = sessionState && typeof sessionState.selected === "string" ? sessionState.selected : "";

  const load = react.useCallback(async () => {
    if (sessionId.length === 0) {
      setData(null);
      setError("当前会话尚未就绪。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await readInventory(sessionId, selected, cwdHint);
      setData(next);
      setCollapsed({});
    } catch (failure) {
      setData(null);
      setError(String(failure?.message ?? failure));
    } finally {
      setLoading(false);
    }
  }, [sessionId, selected, cwdHint]);

  // Switching a window to the mode initialises its workspace at once: the
  // preview, the Agent roster and the model layers all read the same plan, so
  // none of them should have to wait for the first message to create it.
  react.useEffect(() => {
    if (preset !== "hnflow" || sessionId.length === 0) {
      setReadiness(null);
      return undefined;
    }
    let cancelled = false;
    prepareWorkspace(sessionId, cwdHint)
      .then((report) => {
        if (!cancelled) setReadiness(report);
      })
      .catch((failure) => {
        if (!cancelled) setReadiness({ ready: false, reason: String(failure?.message ?? failure), warnings: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [preset, sessionId, cwdHint]);

  react.useEffect(() => {
    if (!open) return undefined;
    void load();
    dialogRef.current?.focus?.();
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, load]);

  react.useEffect(
    () => () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    },
    []
  );

  // Fetch the hovered entry once and keep it in a per-panel cache.
  react.useEffect(() => {
    if (hover === null) {
      setPreview(null);
      return undefined;
    }
    const entry = hover.item;
    const key = `${entry.kind}\u0000${entry.id}`;
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setPreview({ loading: false, error: "", path: entry.path, truncated: false, text: cached });
      return undefined;
    }
    let cancelled = false;
    setPreview({ loading: true, error: "", path: entry.path, truncated: false, text: "" });
    readInventoryText(sessionId, entry.kind, entry.id, cwdHint)
      .then((result) => {
        cacheRef.current.set(key, result.text);
        if (!cancelled) setPreview({ loading: false, error: "", ...result });
      })
      .catch((failure) => {
        if (!cancelled) {
          setPreview({ loading: false, error: String(failure?.message ?? failure), path: entry.path, truncated: false, text: "" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hover, sessionId, cwdHint]);

  if (preset !== "hnflow") return null;

  const openPreview = (item, event) => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    const rect = event.currentTarget.getBoundingClientRect();
    showTimer.current = setTimeout(() => setHover({ item, rect }), 120);
  };

  const closePreview = () => {
    clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 180);
  };

  const keepPreview = () => {
    clearTimeout(hideTimer.current);
  };

  const markCopy = (label) => {
    setCopied(label);
    setTimeout(() => setCopied(""), 1200);
  };

  const button = h(
    "button",
    {
      type: "button",
      style: inventoryStyles.button,
      title: "会话内容预览：查看本会话与该工作区加载的规则、技能、命令、MCP 与人设",
      "aria-label": "会话内容预览",
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      onClick: () => setOpen((value) => !value)
    },
    "▤"
  );

  if (!open) return button;

  const sections = data && Array.isArray(data.sections) ? data.sections : [];

  const modal = reactDom.createPortal(
    h(
      "div",
      {
        style: inventoryStyles.overlay,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }
      },
      h(
        "div",
        {
          ref: dialogRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "会话内容预览",
          tabIndex: -1,
          style: inventoryStyles.dialog,
          onMouseDown: (event) => event.stopPropagation()
        },
        h(
          "div",
          { style: inventoryStyles.header },
          h("span", { style: inventoryStyles.title }, "会话内容预览"),
          h(
            "span",
            { style: inventoryStyles.subtitle },
            data
              ? `${data.agent?.name ?? "无 Agent"} · ${data.cwd === "" ? "/" : data.cwd} · ${data.project}`
              : sessionId
          ),
          h("span", { style: inventoryStyles.spacer }),
          h(
            "button",
            {
              type: "button",
              style: smallButton,
              disabled: loading,
              onClick: () => void load()
            },
            loading ? "刷新中…" : "刷新"
          ),
          h(
            "button",
            {
              type: "button",
              style: smallButton,
              onClick: () => setOpen(false)
            },
            "关闭"
          )
        ),
        h(
          "div",
          { style: inventoryStyles.body },
          readiness !== null && readiness.ready === false
            ? h(
                "div",
                { style: inventoryStyles.warning },
                `工作区未就绪：${readiness.reason}${Array.isArray(readiness.warnings) && readiness.warnings.length > 0 ? `（${readiness.warnings.join("；")}）` : ""}`
              )
            : null,
          error.length > 0
            ? h("div", { style: inventoryStyles.error }, error)
            : loading && data === null
              ? h("div", { style: inventoryStyles.muted }, "加载中…")
              : data === null
                ? h("div", { style: inventoryStyles.muted }, "没有可显示的内容。")
                : sections.map((section) => {
                    const isCollapsed =
                      collapsed[section.kind] === undefined ? section.collapsed === true : collapsed[section.kind];
                    return h(
                      "div",
                      { key: section.kind, style: inventoryStyles.section },
                      h(
                        "button",
                        {
                          type: "button",
                          style: inventoryStyles.sectionHead,
                          "aria-expanded": !isCollapsed,
                          onClick: () =>
                            setCollapsed((current) => ({
                              ...current,
                              [section.kind]: !isCollapsed
                            }))
                        },
                        h("span", { "aria-hidden": true }, isCollapsed ? "▸" : "▾"),
                        h("span", null, section.title ?? section.kind),
                        h("span", { style: inventoryStyles.count }, `(${section.items.length})`)
                      ),
                      isCollapsed
                        ? null
                        : section.items.map((item) =>
                            h(
                              "div",
                              { key: `${section.kind}:${item.id}`, style: inventoryStyles.row },
                              h(
                                "span",
                                { style: inventoryStyles.mark, title: INVENTORY_STATUS[item.status]?.label ?? item.status },
                                INVENTORY_STATUS[item.status]?.mark ?? "·"
                              ),
                              h(
                                "div",
                                { style: inventoryStyles.rowBody },
                                h(
                                  "div",
                                  { style: inventoryStyles.rowName },
                                  h("span", null, item.name || item.id),
                                  item.host_name
                                    ? h("span", { style: inventoryStyles.rowMeta }, item.host_name)
                                    : null
                                ),
                                h(
                                  "div",
                                  { style: inventoryStyles.rowMeta },
                                  [
                                    item.id,
                                    item.group ? `group: ${item.group}` : "",
                                    item.scope ? `scope: ${item.scope}` : "",
                                    item.bytes > 0 ? `${item.bytes} B` : "",
                                    item.status
                                  ]
                                    .filter((part) => part.length > 0)
                                    .join(" · ")
                                ),
                                item.summary
                                  ? h("div", { style: inventoryStyles.rowSummary }, item.summary)
                                  : null
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  style: inventoryStyles.previewButton,
                                  title: "悬停预览全文",
                                  "aria-label": `预览 ${item.name || item.id}`,
                                  onMouseEnter: (event) => openPreview(item, event),
                                  onMouseLeave: closePreview,
                                  onFocus: (event) => openPreview(item, event),
                                  onBlur: closePreview
                                },
                                "◉"
                              )
                            )
                          )
                    );
                  })
        ),
        data
          ? h(
              "div",
              { style: inventoryStyles.cardFoot },
              h("span", null, `预算 ${data.budget.used} / ${data.budget.limit} B`),
              h("span", null, `省略 ${data.budget.omitted}`),
              data.warnings.length > 0 ? h("span", null, `警告 ${data.warnings.length}`) : null,
              h("span", { style: inventoryStyles.spacer }),
              h("span", null, inlineCounts(sections))
            )
          : null
      )
    ),
    document.body
  );

  const card =
    hover !== null && preview !== null
      ? reactDom.createPortal(
          h(
            "div",
            {
              style: Object.assign({}, inventoryStyles.card, placeInventoryCard(hover.rect)),
              onMouseEnter: keepPreview,
              onMouseLeave: closePreview
            },
            h(
              "div",
              { style: inventoryStyles.cardHead },
              h(
                "span",
                { style: inventoryStyles.cardTitle },
                `${INVENTORY_STATUS[hover.item.status]?.label ?? ""} ${hover.item.name || hover.item.id}`
              ),
              h(
                "button",
                {
                  type: "button",
                  style: smallButton,
                  onClick: async () => {
                    const ok = await copyText(hover.item.path ?? "");
                    if (ok) markCopy("path");
                  }
                },
                copied === "path" ? "已复制" : "复制路径"
              ),
              h(
                "button",
                {
                  type: "button",
                  style: smallButton,
                  onClick: async () => {
                    const ok = await copyText(preview.text ?? "");
                    if (ok) markCopy("text");
                  }
                },
                copied === "text" ? "已复制" : "复制全文"
              )
            ),
            h(
              "div",
              { style: inventoryStyles.cardBody },
              preview.loading
                ? h("div", { style: inventoryStyles.muted }, "加载中…")
                : preview.error.length > 0
                  ? h("div", { style: inventoryStyles.error }, preview.error)
                  : preview.text.length === 0
                    ? h("div", { style: inventoryStyles.muted }, "该条目没有正文。")
                    : h("pre", { style: inventoryStyles.pre }, preview.text),
              preview.truncated ? h("div", { style: inventoryStyles.muted }, "内容过长，已截断。") : null
            ),
            h(
              "div",
              { style: inventoryStyles.cardFoot },
              h(
                "span",
                { style: Object.assign({}, inventoryStyles.rowMeta, { flex: "1 1 auto" }) },
                preview.path || hover.item.id
              )
            )
          ),
          document.body
        )
      : null;

  return h(react.Fragment, null, button, modal, card);
}

/**
 * One-line section counts for the dialog footer.
 * @param {object[]} sections - inventory sections.
 * @returns {string} text such as `规则 4 · 技能 12`.
 */
function inlineCounts(sections) {
  return sections
    .filter((section) => section.items.length > 0)
    .map((section) => `${section.title ?? section.kind} ${section.items.length}`)
    .join(" · ");
}


    /**
     * Client plugin body.
     * @param {Record<string, unknown>} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      if (owner !== null) return;
      owner = ctx;
      ctx.effect(() => () => {
        if (owner === ctx) owner = null;
      }, "capability: release the agent picker");
      // The left-strip controls receive only a session id from the composer, so
      // the sessions service is threaded through as a prop: it carries the
      // workspace each session belongs to, which the host needs to initialise the
      // mode before the first turn.
      const sessionsService = ctx.sessions ?? null;
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "capability-agent",
            order: 5,
            inject: (sessionId) => ({
              sessionId,
              sessionsService,
              onSelect: async (name) => {
                const result = await ctx.remote.commands.execute(
                  sessionId,
                  "/capability-agent " + name,
                  []
                );
                if (result && result.ok === false) {
                  throw new Error(
                    `capability: ${result.error?.code ?? "command-failed"}: ${result.error?.message ?? ""}`
                  );
                }
              }
            })
          },
          AgentPicker
        )
      );
      // The inventory button sits next to the Agent picker. It reads the plan
      // that the next step injects, so refreshing after an edit is honest.
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "capability-inventory",
            order: 8,
            inject: (sessionId) => ({ sessionId, sessionsService })
          },
          (props) => h(InventoryBoundary, null, h(InventoryPanel, props))
        )
      );
      // The model-layer selector lives in the right-hand model seat, not in the
      // left strip: that strip belongs to the Agent picker.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "capability-models",
            order: 40,
            label: () => "模型层"
          },
          LayerSettings
        )
      );
      // Full replacement, always: in the HNFlow mode the layer control owns the
      // right-hand model seat. The left strip belongs to the Agent picker alone,
      // so the old `additive` layer control is gone rather than competing with
      // it. The component falls back to the live native catalog outside HNFlow
      // sessions, so the model seat never goes blank.
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots", "modelDirectories", "sessions"], (scope) => {
        try {
          const models = scope.modelDirectories;
          const sessions = scope.sessions;
          scope.slots.inject("conversation.input.model", () =>
            scope.slots.register(
              {
                name: "conversation.input.model",
                priority: -1,
                inject: (sessionId) => {
                  const directory = models.directoryFor(sessionId);
                  const available = sessions.subagentAddress(sessionId) === undefined;
                  return {
                    available,
                    sessionId,
                    directory: directory.store,
                    load: () => {
                      if (available) directory.load().catch(() => {});
                    },
                    select: (selection) =>
                      available ? directory.select(selection) : Promise.resolve(undefined),
                    selectLayer: async (id) => {
                      const result = await ctx.remote.commands.execute(
                        sessionId,
                        "/capability-layer " + id,
                        []
                      );
                      if (result && result.ok === false) {
                        throw new Error(
                          `capability: ${result.error?.code ?? "command-failed"}: ${result.error?.message ?? ""}`
                        );
                      }
                      return result;
                    }
                  };
                }
              },
              ModelSeat
            )
          );
        } catch (failure) {
          console.warn("[capability] model seat replacement failed", failure);
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
}

// HNFlow browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so no
// build step is involved.
//
// Surfaces (docs/architecture.md):
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
function createHnflowModule(require) {
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

    function runOrigin(run) {
      if (run.group) return `能力组 ${run.group}`;
      return run.source === "capability" ? "能力组" : String(run.source ?? "能力组");
    }

    /**
     * Left tree: one section per active capability group.
     * @param {{groups: Record<string, any>[], selected: string, onPick: Function}} props - selection.
     * @returns {unknown} element.
     */
    function FlowTree(props) {
      const groups = Array.isArray(props?.groups) ? props.groups : [];
      const onPick = typeof props?.onPick === "function" ? props.onPick : () => {};
      if (groups.length === 0) return h("div", { style: styles.empty }, "这个工作区没有激活的能力组");
      return h(
        "div",
        { style: styles.tree },
        ...groups.map((group) =>
          h(
            "div",
            { key: group.path, style: styles.group },
            h("div", { style: { ...styles.meta, padding: "4px 8px" } }, `${group.name || shortPath(group.path)} · ${(group.flows ?? []).length} 个流程`),
            group.error ? h("div", { style: { ...styles.meta, paddingLeft: "10px" } }, `读取失败：${group.error}`) : null,
            ...(group.flows ?? []).map((entry) => {
              const key = `${group.path}:${entry.id}`;
              return h(
                "button",
                { type: "button", key, style: props.selected === key ? { ...styles.item, ...styles.itemActive } : styles.item, onClick: () => onPick(group.path, entry) },
                h("span", null, String(entry.name || entry.flowId)),
                h("span", { style: styles.meta }, `${entry.group} · ${entry.flowId}`),
              );
            }),
          ),
        ),
      );
    }

    /**
     * The flow pane: canvas, capability-group metadata and run controls.
     * @param {{flow: Record<string, any> | null, busy: boolean, message: string, onRun: Function}} props - pane.
     * @returns {unknown} element.
     */
    function FlowPane(props) {
      const flow = props?.flow;
      const [input, setInput] = react.useState("{}");
      if (flow === null || flow === undefined) return h("div", { style: styles.empty }, "选择左侧的流程查看画布");
      const owner = `${flow.group || "?"}`;
      return h(
        "div",
        { style: styles.pane },
        h("div", { style: styles.meta }, `${flow.flowName || flow.name || flow.flowId} · 能力组 ${owner} · ${flow.path || ""}`),
        Array.isArray(flow.requires) && flow.requires.length > 0 ? h("div", { style: styles.meta }, `依赖能力组：${flow.requires.join(", ")}`) : null,
        h(FlowCanvas, { definition: flow.definition, run: null }),
        h("div", { style: styles.meta }, "流程属于能力组；节点子会话可使用本组及依赖组的全部规则、技能、Agent、命令与工具。"),
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
            h("span", { style: styles.meta }, `${run.runId} · ${shortPath(run.workspace)} · ${runOrigin(run)}`),
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
        h("div", { style: styles.meta }, `${run.runId} · ${run.status} · ${runOrigin(run)} · ${shortPath(run.workspace)}`),
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
          const started = await postJson("/api/hnflow/start", { workspace: flow.workspace, flow: flow.id || flow.flowId || flow.name, input });
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
      const runs = Array.isArray(state?.runs) ? state.runs : [];
      const inbox = Array.isArray(state?.inbox) ? state.inbox : [];
      const triggers = Array.isArray(state?.triggers) ? state.triggers : [];
      const automation = state?.automation ?? null;
      const facts = state?.facts ?? null;

      const pickFlow = async (workspace, entry) => {
        setSelectedFlow({ ...entry, workspace, definition: null });
        try {
          const resolved = await fetchFlow(workspace, entry.id || entry.flowId || entry.name);
          setSelectedFlow({ ...entry, ...resolved.flow, workspace, definition: resolved.flow.definition });
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
          setSelectedFlow({ ...resolved.flow, workspace: run.workspace });
        } catch {
          // the summary is enough for the timeline
        }
      };

      const left = tab === "flows" ? h(FlowTree, { groups, selected: selectedFlow === null ? "" : `${selectedFlow.workspace}:${selectedFlow.id || selectedFlow.flowId}`, onPick: (workspace, entry) => void pickFlow(workspace, entry) }) : tab === "runs" ? h(RunsBoard, { runs, selected: selectedRun?.runId ?? "", onPick: (run) => void pickRun(run) }) : null;

      const right =
        tab === "flows"
          ? h(FlowPane, { flow: selectedFlow, busy, message, onRun: (flow, text) => void startRun(flow, text) })
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
        state?.degraded === true ? h("div", { style: styles.errorBox }, "能力组未就绪：可以查看流程与运行，但启动会被拒绝。") : null,
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

      registerSlot(ctx, "sidebar.panellist", (slots) => slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 15, label: () => "HNFlow" }));
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
}

// One registration for the whole package: the Loader imports the module named
// after the package, materializes this factory once, and mounts the exported
// plugin for every Loader entry that references the package (the `hnflow-ui`
// row and the `hnflow` row inside the preset). Each half keeps its own mount
// guard, so the second entry is a no-op for the surfaces the first one owns.
window.__ModuleLoader__.load({
  id: "dsh-hnflow",
  factory: (require) => {
    const capability = createCapabilityModule(require);
    const hnflow = createHnflowModule(require);
    return {
      inject: [...new Set([...capability.inject, ...hnflow.inject])],
      apply(ctx) {
        capability.apply(ctx);
        hnflow.apply(ctx);
      },
      internals: hnflow.internals,
    };
  },
});
