"""Model profiles: AI node -> profile -> actual configured LLM."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.workflow.compiler import (
    CompileContext,
    WorkflowCompileError,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry
from deerflow.workflow.model_profiles import (
    ModelProfileError,
    collect_model_profile_ids,
    parse_model_profile_id,
    resolve_model_profile,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

PROFILE = {
    "id": "mp-fast",
    "name": "fast",
    "display_name": "Fast",
    "target_model": "cloud-fast",
    "enabled": True,
}


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _ai(params: dict[str, Any] | None = None) -> Node:
    return Node(
        id="ai",
        type=NodeType.AI_LLM_AGENT,
        params={**(params or {})},
        inputs=[Port(name="in", type=PortType.DATA), Port(name="template_prompt", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _def(params: dict[str, Any] | None = None) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="test-wf",
        name="Test",
        nodes=[_start(), _ai(params), _end()],
        edges=[
            Edge(source="start", source_port="input", target="ai", target_port="in"),
            Edge(source="start", source_port="input", target="ai", target_port="template_prompt"),
            Edge(source="ai", source_port="out", target="end", target_port="in"),
        ],
    )


def _compile_context(profiles: dict[str, dict[str, Any]] | None = None):
    return CompileContext(
        executors=build_default_registry().build_context().executors,
        model_profiles=profiles if profiles is not None else {"mp-fast": PROFILE},
        available_model_names=frozenset({"cloud-fast", "cloud-big"}),
    )


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    yield


class TestPureModelProfiles:
    def test_parse_and_collect(self) -> None:
        assert parse_model_profile_id({"model_profile": " mp-fast "}) == "mp-fast"
        assert parse_model_profile_id({}) is None
        assert collect_model_profile_ids({"params": {"model_profile": "mp-fast"}, "nested": [{"model_profile": "mp-big"}]}) == {"mp-fast", "mp-big"}

    @pytest.mark.parametrize("bad", ["", "   ", 1])
    def test_bad_id(self, bad: Any) -> None:
        with pytest.raises(ModelProfileError):
            parse_model_profile_id({"model_profile": bad})

    def test_resolve(self) -> None:
        assert resolve_model_profile("mp-fast", {"mp-fast": PROFILE}, {"cloud-fast"}) == "cloud-fast"

    def test_unknown_disabled_and_missing_target_fail(self) -> None:
        with pytest.raises(ModelProfileError, match="does not exist"):
            resolve_model_profile("missing", {}, {"cloud-fast"})
        with pytest.raises(ModelProfileError, match="disabled"):
            resolve_model_profile("mp-fast", {"mp-fast": {**PROFILE, "enabled": False}}, {"cloud-fast"})
        with pytest.raises(ModelProfileError, match="unconfigured"):
            resolve_model_profile("mp-fast", {"mp-fast": PROFILE}, {"other"})


class TestCompileValidation:
    def test_profile_compiles(self) -> None:
        compile_definition(_def({"model_profile": "mp-fast"}), context=_compile_context())

    def test_unknown_profile_fails(self) -> None:
        with pytest.raises(WorkflowCompileError, match="does not exist"):
            compile_definition(_def({"model_profile": "mp-missing"}), context=_compile_context())

    def test_disabled_profile_fails(self) -> None:
        with pytest.raises(WorkflowCompileError, match="disabled"):
            compile_definition(
                _def({"model_profile": "mp-fast"}),
                context=_compile_context({"mp-fast": {**PROFILE, "enabled": False}}),
            )

    def test_model_policy_is_removed(self) -> None:
        with pytest.raises(WorkflowCompileError, match="model_policy"):
            compile_definition(
                _def({"model_profile": "mp-fast", "model_policy": {"prefer": "default"}}),
                context=_compile_context(),
            )

    def test_profile_on_non_ai_node_fails(self) -> None:
        definition = WorkflowDefinition(
            id="test-wf",
            name="Test",
            nodes=[
                _start(),
                Node(
                    id="log",
                    type=NodeType.TOOL_LOG,
                    params={"model_profile": "mp-fast"},
                    inputs=[Port(name="in", type=PortType.DATA)],
                    outputs=[Port(name="out", type=PortType.DATA)],
                ),
                _end(),
            ],
            edges=[
                Edge(source="start", source_port="input", target="log", target_port="in"),
                Edge(source="log", source_port="out", target="end", target_port="in"),
            ],
        )
        with pytest.raises(WorkflowCompileError, match="only supported"):
            compile_definition(definition, context=_compile_context())


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> Any:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            return SimpleNamespace(
                status=SimpleNamespace(value="completed"),
                result="ok",
                error=None,
                token_usage_records=None,
                stop_reason=None,
            )

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *a, **k: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda *a, **k: None)
    yield captured


def _runtime() -> WorkflowRuntime:
    app_config = SimpleNamespace(models=[SimpleNamespace(name="cloud-fast", context_window=128000), SimpleNamespace(name="cloud-big", context_window=128000)])
    return WorkflowRuntime(
        context={
            "user_id": "u1",
            "thread_id": "t",
            "app_config": app_config,
            "model_profiles": {"mp-fast": PROFILE},
        }
    )


class TestExecutorModelProfiles:
    @pytest.mark.asyncio
    async def test_profile_resolves_actual_model(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        await exec_llm_agent(_runtime(), {"node_id": "n", "model_profile": "mp-fast"}, {"template_prompt": "hi"})
        assert fake_executor["kwargs"]["config"].model == "cloud-fast"

    @pytest.mark.asyncio
    async def test_missing_profile_fails_loud(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        with pytest.raises(WorkflowExecutionError, match="does not exist"):
            await exec_llm_agent(_runtime(), {"node_id": "n", "model_profile": "missing"}, {"template_prompt": "hi"})

    @pytest.mark.asyncio
    async def test_continue_mode_rejects_profile(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        with pytest.raises(WorkflowExecutionError, match="session continuation"):
            await exec_llm_agent(
                _runtime(),
                {"node_id": "n", "model_profile": "mp-fast"},
                {"template_prompt": "hi", "continue_prompt": "more"},
            )
