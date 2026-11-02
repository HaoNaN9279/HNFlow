"""AgentPort contract: an AI node can run through a non-DeerFlow adapter."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from deerflow.workflow.agent_port import (
    AGENT_ADAPTER_CONTEXT_KEY,
    CAP_TEXT,
    CAP_TOOLS,
    AgentManifest,
    AgentTurnResult,
    check_agent_capabilities,
)
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors.ai import exec_llm_agent


class _FakeAdapter:
    manifest = AgentManifest(name="fake", version="1", capabilities=frozenset({CAP_TEXT, CAP_TOOLS}))

    def __init__(self) -> None:
        self.requests = []

    async def execute(self, request):
        self.requests.append(request)
        return AgentTurnResult(
            status=SimpleNamespace(value="completed"),
            result="adapter result",
            token_usage_records=[{"input_tokens": 2, "output_tokens": 3, "total_tokens": 5}],
        )


@pytest.mark.asyncio
async def test_ai_node_uses_injected_adapter() -> None:
    adapter = _FakeAdapter()
    runtime = WorkflowRuntime(context={AGENT_ADAPTER_CONTEXT_KEY: adapter, "user_id": "u"})

    result = await exec_llm_agent(runtime, {"node_id": "n"}, {"in": "x", "template_prompt": "do {{in}}"})

    assert result["out"]["content"] == "adapter result"
    assert result["__workflow_token_usage"]["total_tokens"] == 5
    assert len(adapter.requests) == 1
    request = adapter.requests[0]
    assert request.task == "do x"
    assert request.system_prompt and "通用 AI 助手" in request.system_prompt
    assert "do x" not in request.system_prompt


def test_capability_check_rejects_missing_tool_support() -> None:
    adapter = _FakeAdapter()
    adapter.manifest = AgentManifest(name="text-only", version="1", capabilities=frozenset({CAP_TEXT}))

    with pytest.raises(ValueError, match="tools"):
        check_agent_capabilities(adapter, frozenset({CAP_TOOLS}))
