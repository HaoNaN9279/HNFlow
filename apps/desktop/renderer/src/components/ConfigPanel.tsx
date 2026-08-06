// ConfigPanel：节点参数配置面板（T6）。
// - 未选中节点：占位提示「选中节点查看参数配置」；
// - 选中节点有 paramsSchema：AntD Form 按 schema 渲染字段（类型→控件映射见 renderField），
//   表单值变化即 dispatch updateNodeParams（实时生效，无保存按钮）；
// - 无 paramsSchema：KV 动态表单回退（Form.List 键值行，支持增删）。
// - 切换节点用 key={node.id} 重挂载内部表单（组件内 useForm 新建实例），
//   保证初始值与字段集合干净跟随节点刷新（避开 rc-field-form 复用实例时的残留值问题）。

import { useMemo } from "react";
import { Button, Empty, Form, Input, InputNumber, Select, Space, Spin, Switch, Typography } from "antd";
import type { ReactNode } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { ParamFieldMetadata } from "../../../src/shared/ipc.js";
import { editorActions, useEditor } from "../editor/state.js";
import { useNodeTypeMetadata } from "../hooks/useNodeCreation.js";

/** KV 动态表单行结构。 */
interface KvRow {
  readonly key: string;
  readonly value: string;
}

/** 值 → 可编辑文本（对象/数组 → JSON 字符串；null/undefined → 空串）。 */
function jsonToText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/** 无 schema 节点：params 记录 → KV 行数组（供 Form.List 初始值）。 */
function paramsToRows(params: Readonly<Record<string, unknown>>): KvRow[] {
  return Object.entries(params).map(([key, value]) => ({ key, value: jsonToText(value) }));
}

/** 无 schema 节点：KV 行数组 → params 记录（空键行跳过）。 */
function rowsToParams(rows: readonly { readonly key?: string; readonly value?: string }[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.key === undefined || row.key === "") {
      continue;
    }
    params[row.key] = row.value ?? "";
  }
  return params;
}

/** schema 表单初始值：取 node.params；json 字段标准化为可编辑文本。 */
function schemaInitialValues(node: EditorGraphNode, schema: readonly ParamFieldMetadata[]): Record<string, unknown> {
  const values: Record<string, unknown> = { ...node.params };
  for (const field of schema) {
    if (field.type === "json" && values[field.key] !== undefined) {
      values[field.key] = jsonToText(values[field.key]);
    }
  }
  return values;
}

/** 字段类型 → 控件映射：string→Input、number→InputNumber、boolean→Switch、select→Select、textarea→TextArea、json→TextArea。 */
function renderField(field: ParamFieldMetadata): ReactNode {
  switch (field.type) {
    case "string":
      return <Input placeholder={field.placeholder} />;
    case "number":
      return <InputNumber style={{ width: "100%" }} placeholder={field.placeholder} />;
    case "boolean":
      return <Switch />;
    case "select":
      return <Select {...(field.options === undefined ? {} : { options: [...field.options] })} placeholder={field.placeholder} />;
    case "textarea":
      return <Input.TextArea rows={3} placeholder={field.placeholder} />;
    case "json":
      return <Input.TextArea rows={4} placeholder={field.placeholder ?? "JSON 文本"} />;
  }
}

/** 有 schema：按字段元数据渲染表单（内部自持 form 实例，key 切换即重建）。 */
function SchemaForm(props: {
  readonly node: EditorGraphNode;
  readonly schema: readonly ParamFieldMetadata[];
  readonly onParamsChange: (params: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  const initialValues = useMemo(
    () => schemaInitialValues(props.node, props.schema),
    [props.node, props.schema],
  );
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialValues}
      onValuesChange={(_changed, all) => props.onParamsChange(all)}
    >
      {props.schema.map((field) => (
        <Form.Item
          key={field.key}
          name={field.key}
          label={field.label}
          valuePropName={field.type === "boolean" ? "checked" : "value"}
          {...(field.required === true ? { rules: [{ required: true, message: `请输入${field.label}` }] } : {})}
          {...(field.description === undefined ? {} : { extra: field.description })}
        >
          {renderField(field)}
        </Form.Item>
      ))}
    </Form>
  );
}

/** 无 schema：KV 动态表单回退（键/值两列，可增删行）。 */
function KvForm(props: {
  readonly node: EditorGraphNode;
  readonly onParamsChange: (params: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  const initialValues = useMemo(() => ({ kvRows: paramsToRows(props.node.params) }), [props.node]);
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialValues}
      onValuesChange={(_changed, all: { readonly kvRows?: readonly { readonly key?: string; readonly value?: string }[] }) =>
        props.onParamsChange(rowsToParams(all.kvRows ?? []))
      }
    >
      <Form.List name="kvRows">
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <Space key={field.key} align="baseline" style={{ display: "flex" }}>
                <Form.Item name={[field.name, "key"]} rules={[{ required: true, message: "键不能为空" }]} style={{ flex: 1 }}>
                  <Input placeholder="参数键" />
                </Form.Item>
                <Form.Item name={[field.name, "value"]} style={{ flex: 1 }}>
                  <Input placeholder="参数值" />
                </Form.Item>
                <Button type="text" danger onClick={() => remove(field.name)}>
                  删
                </Button>
              </Space>
            ))}
            <Button block onClick={() => add({ key: "", value: "" })}>
              添加参数
            </Button>
          </>
        )}
      </Form.List>
    </Form>
  );
}

export default function ConfigPanel() {
  const { state, dispatch } = useEditor();
  const { metadata, failed } = useNodeTypeMetadata();

  const node = useMemo(
    () => state.graph.nodes.find((n) => n.id === state.selectedNodeId),
    [state.graph, state.selectedNodeId],
  );
  const meta = useMemo(
    () => (node === undefined ? undefined : metadata?.find((m) => m.type === node.type)),
    [metadata, node],
  );
  const schema = meta?.paramsSchema;
  const hasSchema = schema !== undefined && schema.length > 0;

  if (node === undefined) {
    return (
      <div className="config-panel-empty">
        <Empty description="选中节点查看参数配置" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  return (
    <div className="config-panel">
      <Typography.Text strong>{node.name}</Typography.Text>
      {metadata === undefined && !failed ? (
        <div style={{ padding: 24, textAlign: "center" }}>
          <Spin size="small" />
        </div>
      ) : failed ? (
        <Empty description="参数元数据加载失败" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : hasSchema && schema !== undefined ? (
        <SchemaForm
          key={node.id}
          node={node}
          schema={schema}
          onParamsChange={(params) => dispatch(editorActions.updateNodeParams(node.id, params))}
        />
      ) : (
        <KvForm
          key={node.id}
          node={node}
          onParamsChange={(params) => dispatch(editorActions.updateNodeParams(node.id, params))}
        />
      )}
    </div>
  );
}
