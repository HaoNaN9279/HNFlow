// UpgradeDialog：模板版本升级向导（v0.4.1）。
// 打开：右键菜单「升级版本」→ NodeUiProvider 注入 target（subworkflow 节点，X6 data）。
// 加载：解析 params.template（"name@version"）→ listTemplates 定位 → loadTemplateVersion 预览 →
//       buildUpgradePlan 计算端口映射计划。
// 展示：端口映射表（自动匹配绿标 / 手动 Select 选目标端口或断开 / 有关联边标注）+ 新增端口 + 断开提示。
// 应用：applyUpgradePlan 重建端口与模板引用 → 原子提交（先删关联边后换节点）→
//       EditorState→X6 reconcile 同步（回流 history:false，不入 undo 栈——验收未要求升级可撤销）。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Descriptions, Modal, Select, Spin, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { Node } from "@core/model/types";
import { applyUpgradePlan, buildUpgradePlan, type PortMapping, type UpgradePlan } from "@core/templates/upgrade-plan";
import type { TemplateSummary } from "../../../src/shared/ipc.js";
import { editorActions, useEditor } from "./state.js";

/** 断开占位值：与真实端口 key 区分（接口 key 不可能是该值）。 */
const DISCONNECT_VALUE = "__disconnect__";

/** 解析 "name@version" 模板引用：非法（缺失/空段）返回 undefined。 */
function parseTemplateRef(ref: unknown): { readonly name: string; readonly version: string } | undefined {
  if (typeof ref !== "string") return undefined;
  const sep = ref.lastIndexOf("@");
  if (sep <= 0 || sep === ref.length - 1) return undefined;
  return { name: ref.slice(0, sep), version: ref.slice(sep + 1) };
}

/** IPC/核心库错误 → message 文案（主进程已转中文友好消息，透传即可）。 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** 升级向导加载完成的上下文（打开瞬间快照）。 */
interface UpgradeContext {
  readonly node: EditorGraphNode;
  readonly name: string;
  readonly currentVersion: string;
  readonly summary: TemplateSummary;
  readonly targetVersion: string;
  readonly plan: UpgradePlan;
  /** 适配对象：省略 subworkflow（核心逻辑只读 ports/params，用不到子图）。 */
  readonly adapted: Node;
  readonly isLatest: boolean;
  readonly preview: { readonly nodeCount: number; readonly edgeCount: number };
}

/** 升级向导 props：target 由 NodeUiProvider 注入（upgradeTarget 变化即打开）。 */
interface UpgradeDialogProps {
  readonly target: EditorGraphNode | undefined;
  readonly onClose: () => void;
}

export function UpgradeDialog({ target, onClose }: UpgradeDialogProps) {
  const { state, dispatch } = useEditor();
  const [context, setContext] = useState<UpgradeContext | undefined>(undefined);
  const [manualSelections, setManualSelections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  // 打开时加载：解析模板引用 → listTemplates 定位 → loadTemplateVersion 预览 → buildUpgradePlan。
  useEffect(() => {
    const node = target;
    if (node === undefined) return; // 关闭态：Modal 隐藏不渲染内容，下次打开重新加载
    let cancelled = false;
    setContext(undefined);
    setManualSelections({});
    setLoading(true);
    void (async () => {
      try {
        const ref = parseTemplateRef(node.params["template"]);
        if (ref === undefined) {
          message.error("节点未锁定模板版本（params.template 缺失或格式非法）。");
          onClose();
          return;
        }
        const templates = await window.hnflow.listTemplates();
        const summary = templates.find((t) => t.name === ref.name);
        if (summary === undefined) {
          message.error(`模板 "${ref.name}" 不存在，无法升级。`);
          onClose();
          return;
        }
        const targetVersion = summary.currentVersion;
        const preview = await window.hnflow.loadTemplateVersion({ name: ref.name, version: targetVersion });
        // 关联边：当前图与该节点端口相连的边（打开瞬间快照）。
        const edges = state.graph.edges.filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id);
        const adapted: Node = {
          id: node.id, type: node.type, name: node.name, params: node.params,
          inputs: node.inputs, outputs: node.outputs, position: node.position,
        };
        const plan = buildUpgradePlan({ node: adapted, targetInterface: summary.interface, edges });
        if (!cancelled) {
          setContext({
            node,
            name: ref.name,
            currentVersion: ref.version,
            summary,
            targetVersion,
            plan,
            adapted,
            isLatest: ref.version === targetVersion,
            preview: { nodeCount: preview.workflow.nodes.length, edgeCount: preview.workflow.edges.length },
          });
        }
      } catch (error) {
        console.error("加载升级信息失败", error);
        if (!cancelled) {
          message.error(errorText(error, "加载升级信息失败"));
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 依赖仅 target：state.graph.edges 取打开瞬间快照，加载期间图变化不重置用户选择
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleApply = useCallback(async () => {
    if (context === undefined) return;
    const { node, adapted, plan, name, targetVersion } = context;
    // 手动映射：非「断开」的选择 → currentKey → 目标 key（缺省视为断开）。
    const manualMappings: Record<string, string> = {};
    for (const [currentKey, value] of Object.entries(manualSelections)) {
      if (value !== DISCONNECT_VALUE) manualMappings[currentKey] = value;
    }
    setApplying(true);
    try {
      const result = applyUpgradePlan({ node: adapted, plan, templateName: name, targetVersion, manualMappings });
      // 原子提交：先删关联边（幂等）后换节点；经 EditorState→X6 reconcile 同步，不入 undo 栈。
      for (const edgeId of result.edgesToRemove) dispatch(editorActions.removeEdge(edgeId));
      // 显式重建节点：result.node 为 core Node（subworkflow?: Workflow 与 EditorGraphNode 不兼容），
      // 适配对象已省略 subworkflow，逐字段重建并补回原节点内嵌子图与坐标（避免类型断言）。
      const newNode: EditorGraphNode = {
        id: result.node.id, type: result.node.type, name: result.node.name,
        params: result.node.params, inputs: result.node.inputs, outputs: result.node.outputs,
        position: result.node.position ?? node.position,
        ...(node.subworkflow === undefined ? {} : { subworkflow: node.subworkflow }),
      };
      dispatch(editorActions.updateNode(node.id, newNode));
      message.success(`已升级到 ${name}@${targetVersion}`);
      handleClose();
    } catch (error) {
      console.error("升级失败", error);
      message.error(errorText(error, "升级失败"));
    } finally {
      setApplying(false);
    }
  }, [context, dispatch, manualSelections, handleClose]);

  const open = target !== undefined;
  const isLatest = context?.isLatest ?? false;

  const renderBody = (ctx: UpgradeContext): ReactNode => {
    const targetKeysOf = (mapping: PortMapping): readonly string[] =>
      mapping.kind === "input" ? ctx.summary.interface.inputs : ctx.summary.interface.outputs;
    // 实际将断开的边数：手动区未映射（选「断开」）端口关联边（与 applyUpgradePlan.edgesToRemove 一致）。
    const disconnectCount = ctx.plan.manual
      .filter((m) => (manualSelections[m.currentKey] ?? DISCONNECT_VALUE) === DISCONNECT_VALUE)
      .reduce((sum, m) => sum + m.edgeIds.length, 0);
    const columns: ColumnsType<PortMapping> = [
      {
        title: "端口 key",
        key: "port",
        dataIndex: "currentKey",
        render: (value: string, mapping: PortMapping) => (
          <span>
            {mapping.kind === "input" ? "输入" : "输出"} {value}
            {mapping.hasEdge && <Tag color="orange" style={{ marginLeft: 8 }}>有关联边</Tag>}
          </span>
        ),
      },
      {
        title: "处理",
        key: "mode",
        render: (_value: string, mapping: PortMapping) =>
          mapping.auto ? <Tag color="green">自动匹配</Tag> : <Tag color="orange">手动</Tag>,
      },
      {
        title: "目标端口",
        key: "target",
        render: (_value: string, mapping: PortMapping) =>
          mapping.auto ? (
            <span>{mapping.currentKey}（同名）</span>
          ) : (
            <Select
              size="small"
              style={{ width: 160 }}
              value={manualSelections[mapping.currentKey] ?? DISCONNECT_VALUE}
              onChange={(value) =>
                setManualSelections((prev) => {
                  const next = { ...prev };
                  if (value === DISCONNECT_VALUE) delete next[mapping.currentKey];
                  else next[mapping.currentKey] = value;
                  return next;
                })
              }
              options={[
                { value: DISCONNECT_VALUE, label: "断开" },
                ...targetKeysOf(mapping).map((key) => ({ value: key, label: key })),
              ]}
            />
          ),
      },
    ];
    return (
      <>
        {ctx.isLatest && (
          <Alert type="info" showIcon message="当前已是最新版本，无需升级。" style={{ marginBottom: 12 }} />
        )}
        <Descriptions size="small" column={1} style={{ marginBottom: 8 }}>
          <Descriptions.Item label="版本">{ctx.currentVersion} → {ctx.targetVersion}</Descriptions.Item>
          <Descriptions.Item label="目标版本预览">{ctx.preview.nodeCount} 节点 / {ctx.preview.edgeCount} 边</Descriptions.Item>
        </Descriptions>
        <Table<PortMapping> size="small" rowKey="currentKey" columns={columns} dataSource={[...ctx.plan.mappings]} pagination={false} style={{ marginBottom: 12 }} />
        {ctx.plan.addedKeys.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {ctx.plan.addedKeys.map((added) => (
              <Tag key={`${added.kind}:${added.key}`} color="blue" style={{ marginRight: 8 }}>
                {added.kind === "input" ? "输入" : "输出"} {added.key}（升级后新增）
              </Tag>
            ))}
          </div>
        )}
        {ctx.plan.edgeIdsToDisconnect.length > 0 && (
          <Alert type="warning" showIcon message={`升级后 ${disconnectCount} 条关联边将断开，请检查端口映射。`} />
        )}
      </>
    );
  };

  return (
    <Modal
      title={context === undefined ? "升级模板版本" : `升级 ${context.name}：${context.currentVersion} → ${context.targetVersion}`}
      open={open}
      onCancel={handleClose}
      onOk={handleApply}
      confirmLoading={applying}
      okText="确认升级"
      cancelText="取消"
      okButtonProps={{ disabled: context === undefined || isLatest || applying }}
      width={640}
      maskClosable={false}
    >
      {context === undefined ? (
        loading ? (
          <div style={{ textAlign: "center", padding: 32 }}>
            <Spin />
          </div>
        ) : null
      ) : (
        renderBody(context)
      )}
    </Modal>
  );
}
