"""Render behaviour: the Markdown brief carries the sections a reviewer needs."""

from __future__ import annotations

import pytest

from hnflow_forge.render import render_markdown
from tests.test_lint import base_definition


def test_render_contains_core_sections() -> None:
    markdown = render_markdown(base_definition())
    assert "# 测试流程" in markdown
    assert "## 启动输入" in markdown
    assert "## 节点" in markdown
    assert "## 边" in markdown
    assert "## 人工与验收点" in markdown
    assert "## 运行前提" in markdown
    assert "flowchart TD" in markdown
    assert "`draft`" in markdown
    assert "`approve`" in markdown


def test_render_lists_request_deliverable() -> None:
    definition = base_definition()
    definition["nodes"].append(
        {
            "id": "art",
            "type": "request",
            "deliverable": {
                "type": "object",
                "required": ["files"],
                "properties": {"files": {"type": "array", "items": {"type": "string"}}},
            },
            "whyHuman": "需要真实手感",
            "deadline": {"hours": 72},
        }
    )
    definition["nodes"].append(
        {
            "id": "accept",
            "type": "verify",
            "against": "art",
            "checks": ["schema", "judge"],
            "judge": {"preset": "standard", "criteria": "文件是否可用"},
        }
    )
    definition["edges"] = [
        {"id": "e1", "from": "draft", "to": "art", "when": {"kind": "status", "is": "done"}},
        {"id": "e2", "from": "art", "to": "accept", "when": {"kind": "status", "is": "done"}},
        {"id": "e3", "from": "accept", "to": "approve", "when": {"kind": "artifact.accepted", "is": True}},
    ]
    markdown = render_markdown(definition)
    assert "需要真实手感" in markdown
    assert "`standard`" in markdown
    assert "artifact.accepted: True" in markdown


def test_render_rejects_non_definition() -> None:
    with pytest.raises(ValueError):
        render_markdown({"nodes": []})
