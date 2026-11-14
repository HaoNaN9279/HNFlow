"""Render a flow definition as a human-reviewable Markdown brief."""

from __future__ import annotations

import json
from typing import Any

NODE_LABELS = {
    "agent": "子 Agent",
    "judge": "独立判定",
    "merge": "插件（确定性）",
    "gate": "人：裁决",
    "request": "人：交付",
    "verify": "插件验收",
}


def _first_line(text: Any) -> str:
    if not isinstance(text, str):
        return ""
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line if len(line) <= 120 else f"{line[:117]}…"


def _schema_text(schema: Any) -> str:
    return json.dumps(schema, ensure_ascii=False, indent=2)


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |")
    return lines


def _when_text(when: Any) -> str:
    if not isinstance(when, dict):
        return "always"
    kind = when.get("kind", "always")
    if kind == "always":
        return "always"
    return f"{kind}: {when.get('is')}"


def _mermaid(definition: dict[str, Any]) -> list[str]:
    nodes = definition.get("nodes") or []
    edges = definition.get("edges") or []
    lines = ["```mermaid", "flowchart TD"]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id"))
        label = f"{node_id}<br/>{node.get('type')}"
        shape = ("[", "]")
        if node.get("type") == "gate":
            shape = ("{", "}")
        elif node.get("type") in ("request", "verify"):
            shape = ("((", "))")
        lines.append(f'    {node_id}{shape[0]}"{label}"{shape[1]}')
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        lines.append(f"    {edge.get('from')} -->|{_when_text(edge.get('when'))}| {edge.get('to')}")
    lines.append("```")
    return lines


def render_markdown(definition: Any) -> str:
    """Return a Markdown brief for one parsed definition."""
    if not isinstance(definition, dict) or not isinstance(definition.get("flow"), dict):
        raise ValueError("definition must be an object with a flow object")
    flow = definition["flow"]
    nodes = [node for node in definition.get("nodes") or [] if isinstance(node, dict)]
    edges = [edge for edge in definition.get("edges") or [] if isinstance(edge, dict)]
    lines: list[str] = [f"# {flow.get('name') or flow.get('id')}", ""]

    description = flow.get("description")
    if isinstance(description, str) and description.strip():
        lines += [description.strip(), ""]
    lines.append(f"- flow id：`{flow.get('id')}`")
    if flow.get("tags"):
        lines.append(f"- tags：{', '.join(str(tag) for tag in flow['tags'])}")
    lines += [
        f"- 节点 {len(nodes)} 个，边 {len(edges)} 条",
        f"- 起点：{_endpoint(definition, nodes, first=True)}；终点：{_endpoint(definition, nodes, first=False)}",
        "",
    ]

    flow_input = definition.get("input")
    lines += ["## 启动输入", ""]
    if isinstance(flow_input, dict) and isinstance(flow_input.get("properties"), dict):
        required = set(flow_input.get("required") or [])
        rows = [
            [f"`{name}`", json.dumps(schema, ensure_ascii=False), "是" if name in required else "否"]
            for name, schema in flow_input["properties"].items()
        ]
        lines += _table(["字段", "schema", "必填"], rows)
    else:
        lines.append("（未声明输入 schema）")
    lines.append("")

    lines += ["## 节点", ""]
    rows = []
    for node in nodes:
        node_id = str(node.get("id"))
        kind = str(node.get("type"))
        detail = (
            node.get("title")
            or _first_line(node.get("instruction"))
            or node.get("criteria")
            or (node.get("whyHuman") if kind == "request" else None)
            or (f"验收 {node.get('against')}" if kind == "verify" else None)
            or ""
        )
        rows.append([f"`{node_id}`", kind, NODE_LABELS.get(kind, kind), str(detail)])
    lines += _table(["节点", "类型", "执行者", "职责"], rows)
    lines.append("")

    lines += ["## 边", ""]
    edge_rows = [
        [f"`{edge.get('id')}`", str(edge.get("from")), str(edge.get("to")), _when_text(edge.get("when"))]
        for edge in edges
    ]
    lines += _table(["id", "从", "到", "条件"], edge_rows) if edge_rows else ["（没有边）"]
    lines.append("")

    human = [node for node in nodes if node.get("type") in ("gate", "request", "verify")]
    lines += ["## 人工与验收点", ""]
    if not human:
        lines.append("（没有人工介入点）")
    for node in human:
        kind = node.get("type")
        node_id = node.get("id")
        if kind == "gate":
            lines.append(f"### gate `{node_id}`：{node.get('title') or '未命名'}")
            if node.get("detail"):
                lines.append(f"- 说明：{node['detail']}")
            if node.get("options"):
                lines.append(f"- 选项：{', '.join(str(option) for option in node['options'])}")
            if node.get("deadline"):
                lines.append(f"- 期限：{json.dumps(node['deadline'], ensure_ascii=False)}，过期策略 {node.get('onExpire', 'remind')}")
        elif kind == "request":
            lines.append(f"### request `{node_id}`：需要人交付")
            lines.append(f"- 为什么必须由人：{node.get('whyHuman') or '（未声明）'}")
            if node.get("deadline"):
                lines.append(f"- 期限：{json.dumps(node['deadline'], ensure_ascii=False)}，过期策略 {node.get('onExpire', 'remind')}")
            lines += ["", "交付物 schema：", "", "```json", _schema_text(node.get("deliverable")), "```"]
        else:
            lines.append(f"### verify `{node_id}`：验收 `{node.get('against')}`")
            checks = node.get("checks", ["schema"])
            lines.append(f"- 检查：{', '.join(str(check) for check in checks)}")
            judge = node.get("judge")
            if isinstance(judge, dict):
                lines.append(f"- judge preset：`{judge.get('preset')}`；标准：{judge.get('criteria') or '（未写）'}")
            if node.get("onReject"):
                lines.append(f"- 拒绝策略：{json.dumps(node['onReject'], ensure_ascii=False)}")
        lines.append("")

    lines += ["## 契约", ""]
    for node in nodes:
        node_id = node.get("id")
        parts = []
        if node.get("input") is not None:
            parts.append(("input", node["input"]))
        if node.get("output") is not None:
            parts.append(("output", node["output"]))
        if not parts:
            continue
        lines.append(f"### `{node_id}`")
        for port, schema in parts:
            lines += ["", f"{port}：", "", "```json", _schema_text(schema), "```"]
        lines.append("")

    presets = sorted(
        {
            str(node.get("preset"))
            for node in nodes
            if isinstance(node.get("preset"), str)
        }
        | {
            str(node["judge"]["preset"])
            for node in nodes
            if isinstance(node.get("judge"), dict) and isinstance(node["judge"].get("preset"), str)
        }
    )
    models = sorted({str(node["model"]) for node in nodes if isinstance(node.get("model"), str)})
    lines += ["## 运行前提", ""]
    lines.append(f"- preset：{', '.join(presets) or '（无）'}（须在宿主 allowlist 内）")
    if models:
        lines.append(f"- 模型层：{', '.join(models)}（须在 HNFlow 本机存在）")
    lines.append("- 发布与门禁裁决是人的动作；草稿可运行但不算发布。")
    lines.append("")

    lines += ["## 流程形状", "", *_mermaid(definition), ""]
    return "\n".join(lines)


def _endpoint(definition: dict[str, Any], nodes: list[dict[str, Any]], *, first: bool) -> str:
    edges = [edge for edge in definition.get("edges") or [] if isinstance(edge, dict)]
    ids: list[str] = []
    for node in nodes:
        node_id = str(node.get("id"))
        touching = [edge for edge in edges if (edge.get("to") if first else edge.get("from")) == node_id]
        if not touching:
            ids.append(node_id)
    return ", ".join(ids) if ids else "（无）"
