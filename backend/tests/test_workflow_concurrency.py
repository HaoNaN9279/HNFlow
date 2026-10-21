"""Tests for N13 concurrency governance.

Two independent additions to the workflow engine:

- **Fan-in merge** (``params.merge``): a node input port fed by several parallel
  branches no longer silently keeps only the last edge — the author picks
  ``overwrite`` (default) / ``array`` / ``error``.
- **Automatic resource locking** (N13): executors declare resource access and
  the compiler holds cross-process locks for writes around the executor call.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.locks.file_lock import reset_file_locks_for_tests, resource_lock
from deerflow.workflow.compiler import (
    WorkflowCompileError,
    WorkflowRuntime,
    clear_compile_cache,
    compile_definition,
)
from deerflow.workflow.executors import WorkflowExecutionError, build_default_registry
from deerflow.workflow.executors.asset import asset_resource_access
from deerflow.workflow.executors.data import file_resource_access
from deerflow.workflow.executors.knowledge import knowledge_resource_access
from deerflow.workflow.executors.local_app import app_resource_access
from deerflow.workflow.executors.tool import bash_resource_access, tool_invoke_resource_access
from deerflow.workflow.resource_access import ResourceAccess, host_write_access, sandbox_write_access, write_locks
from deerflow.workflow.resource_locking import ResourceLockError, hold_resource_locks
from deerflow.workflow.schema import (
    Edge,
    Node,
    NodeType,
    Port,
    PortType,
    WorkflowDefinition,
)

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _start() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _data_node(id_: str, type_: NodeType, *, params: dict[str, Any] | None = None, outputs: list[Port] | None = None) -> Node:
    return Node(
        id=id_,
        type=type_,
        params=params or {},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=outputs if outputs is not None else [Port(name="out", type=PortType.DATA)],
    )


def _def(nodes: list[Node], edges: list[Edge]) -> WorkflowDefinition:
    return WorkflowDefinition(id="test-wf", name="Test Workflow", nodes=nodes, edges=edges)


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    reset_file_locks_for_tests()
    yield
    reset_file_locks_for_tests()


# ═══════════════════════════════════════════════════════════════════════════════
# A1 — fan-in merge
# ═══════════════════════════════════════════════════════════════════════════════


def _fan_in_graph(policy: str | None, *, a_value: Any = "A", captured: list[Any]) -> Any:
    sink_params = {} if policy is None else {"merge": {"in": policy}}
    nodes = [
        _start(),
        _data_node("a", NodeType.DATA_JSON),
        _data_node("b", NodeType.DATA_REGEX),
        _data_node("sink", NodeType.DATA_CONVERT, params=sink_params, outputs=[Port(name="out", type=PortType.DATA)]),
        _end(),
    ]
    edges = [
        Edge(source="start", source_port="input", target="a", target_port="in"),
        Edge(source="start", source_port="input", target="b", target_port="in"),
        Edge(source="a", source_port="out", target="sink", target_port="in"),
        Edge(source="b", source_port="out", target="sink", target_port="in"),
        Edge(source="sink", source_port="out", target="end", target_port="in"),
    ]

    def _sink(_rt: Any, _p: dict, i: dict) -> dict[str, Any]:
        captured.append(i.get("in"))
        return {}

    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_JSON] = lambda _rt, _p, _i: {} if a_value is None else {"out": a_value}
    ctx.executors[NodeType.DATA_REGEX] = lambda _rt, _p, _i: {"out": "B"}
    ctx.executors[NodeType.DATA_CONVERT] = _sink
    return compile_definition(_def(nodes, edges), context=ctx)


class TestFanInMerge:
    @pytest.mark.asyncio
    async def test_overwrite_is_the_default_last_edge_wins(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph(None, captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == ["B"]

    @pytest.mark.asyncio
    async def test_array_collects_all_upstream_values_in_edge_order(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("array", captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == [["A", "B"]]

    @pytest.mark.asyncio
    async def test_array_skips_a_producer_that_wrote_nothing(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("array", a_value=None, captured=captured)
        await graph.ainvoke({"wf:start:input": "seed"})
        assert captured == [["B"]]

    @pytest.mark.asyncio
    async def test_error_policy_raises_on_conflicting_sources(self) -> None:
        captured: list[Any] = []
        graph = _fan_in_graph("error", captured=captured)
        with pytest.raises(WorkflowExecutionError):
            await graph.ainvoke({"wf:start:input": "seed"})

    def test_merge_referencing_unknown_port_is_compile_error(self) -> None:
        nodes = [
            _start(),
            _data_node("a", NodeType.DATA_JSON),
            _data_node("sink", NodeType.DATA_CONVERT, params={"merge": {"nope": "array"}}, outputs=[Port(name="out", type=PortType.DATA)]),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="start", source_port="input", target="sink", target_port="in"),
            Edge(source="a", source_port="out", target="sink", target_port="in"),
            Edge(source="sink", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=build_default_registry().build_context())

    def test_merge_with_unknown_policy_is_compile_error(self) -> None:
        nodes = [
            _start(),
            _data_node("a", NodeType.DATA_JSON),
            _data_node("sink", NodeType.DATA_CONVERT, params={"merge": {"in": "merge-lol"}}, outputs=[Port(name="out", type=PortType.DATA)]),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="a", target_port="in"),
            Edge(source="start", source_port="input", target="sink", target_port="in"),
            Edge(source="a", source_port="out", target="sink", target_port="in"),
            Edge(source="sink", source_port="out", target="end", target_port="in"),
        ]
        with pytest.raises(WorkflowCompileError):
            compile_definition(_def(nodes, edges), context=build_default_registry().build_context())


# ═══════════════════════════════════════════════════════════════════════════════
# A2 — automatic resource access and locking
# ═══════════════════════════════════════════════════════════════════════════════


def _runtime(thread_id: str = "thread-1", user_id: str = "user-1") -> WorkflowRuntime:
    return WorkflowRuntime(context={"thread_id": thread_id, "user_id": user_id})


def _file_pair_graph(operation: str, state: dict[str, int]) -> Any:
    """Two parallel ``data:file`` nodes, with a recording executor."""

    async def _exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
        state["active"] += 1
        state["max"] = max(state["max"], state["active"])
        await asyncio.sleep(0.05)
        state["active"] -= 1
        return {}

    nodes = [
        _start(),
        _data_node("n1", NodeType.DATA_FILE, params={"operation": operation, "path": "/mnt/user-data/workspace/a.txt"}),
        _data_node("n2", NodeType.DATA_FILE, params={"operation": operation, "path": "/mnt/user-data/workspace/b.txt"}),
        _end(),
    ]
    edges = [
        Edge(source="start", source_port="input", target="n1", target_port="in"),
        Edge(source="start", source_port="input", target="n2", target_port="in"),
        Edge(source="n1", source_port="out", target="end", target_port="in"),
        Edge(source="n2", source_port="out", target="end", target_port="in"),
    ]
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_FILE] = _exec
    return compile_definition(_def(nodes, edges), context=ctx)


class TestResourceAccessDeclarations:
    def test_sandbox_lock_is_scoped_to_user_and_thread(self) -> None:
        first = sandbox_write_access(_runtime("thread-a", "user-1"))
        same = sandbox_write_access(_runtime("thread-a", "user-1"))
        other_thread = sandbox_write_access(_runtime("thread-b", "user-1"))
        other_user = sandbox_write_access(_runtime("thread-a", "user-2"))

        assert first == same
        assert first.key != other_thread.key
        assert first.key != other_user.key
        assert first.label == "sandbox:thread-a"

    def test_host_lock_normalizes_the_path(self, tmp_path: Path) -> None:
        path = tmp_path / "out" / ".." / "out" / "asset.blend"
        first = host_write_access(path)
        second = host_write_access(str(path))

        assert first == second
        assert first.label.startswith("host:")

    def test_read_access_does_not_participate_in_locking(self) -> None:
        read = ResourceAccess("wf_read", "read", "read")
        write = ResourceAccess("wf_write", "write", "write")

        assert write_locks([read]) == ()
        assert write_locks([read, write]) == (write,)

    def test_file_accessor_only_locks_writes(self) -> None:
        runtime = _runtime()

        assert file_resource_access(runtime, {"operation": "read"}, {}) == ()
        assert file_resource_access(runtime, {"operation": "write"}, {}) == (sandbox_write_access(runtime),)

    def test_knowledge_accessor_only_locks_ingest(self) -> None:
        runtime = _runtime()

        assert knowledge_resource_access(runtime, {"operation": "retrieve", "collection": "docs"}, {}) == ()
        accesses = knowledge_resource_access(runtime, {"operation": "ingest", "collection": "docs"}, {})
        assert accesses[0].label == "knowledge:docs"

    def test_app_accessor_locks_every_app_operation(self) -> None:
        runtime = _runtime()
        for params in (
            {"app": "blender"},
            {"app": "blender", "mode": "launch"},
            {"app": "blender", "script": "render"},
            {"app": "blender", "for": "idle"},
            {"app": "blender", "collect": True},
        ):
            assert app_resource_access(runtime, params, {})[0].label == "app:blender"

    def test_bash_accessor_locks_the_sandbox(self) -> None:
        runtime = _runtime()
        assert bash_resource_access(runtime, {}, {}) == (sandbox_write_access(runtime),)

    def test_tool_invoke_accessor_only_locks_known_providers(self) -> None:
        runtime = _runtime()

        assert tool_invoke_resource_access(runtime, {"provider": "mcp", "tool": "search"}, {}) == ()
        assert tool_invoke_resource_access(runtime, {"provider": "sandbox", "tool": "read_file"}, {}) == (sandbox_write_access(runtime),)
        assert tool_invoke_resource_access(runtime, {"provider": "app", "tool": "app_blender"}, {})[0].label == "app:blender"
        assert tool_invoke_resource_access(runtime, {"provider": "builtin", "tool": "write_file"}, {}) == (sandbox_write_access(runtime),)
        assert tool_invoke_resource_access(runtime, {"provider": "builtin", "tool": "read_file"}, {}) == ()

    def test_asset_accessor_maps_each_operation(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        import deerflow.workflow.executors.asset as asset_executor

        runtime = _runtime()
        assert asset_resource_access(runtime, {"operation": "inspect"}, {}) == ()
        assert asset_resource_access(runtime, {"operation": "import"}, {}) == (sandbox_write_access(runtime),)
        assert asset_resource_access(runtime, {"operation": "convert"}, {}) == (sandbox_write_access(runtime),)

        monkeypatch.setattr(asset_executor, "_config", lambda: SimpleNamespace())
        monkeypatch.setattr(asset_executor, "_source_ref", lambda *_args, **_kwargs: SimpleNamespace(path="/mnt/user-data/outputs/a.blend"))
        target = tmp_path / "exports" / "a.blend"
        monkeypatch.setattr(asset_executor, "_resolve_host_destination", lambda *_args, **_kwargs: target)

        accesses = asset_resource_access(runtime, {"operation": "export"}, {})
        assert accesses == (host_write_access(str(target)),)


class TestAutomaticResourceLock:
    @pytest.mark.asyncio
    async def test_parallel_writes_to_the_sandbox_are_serialized(self) -> None:
        state = {"active": 0, "max": 0}
        graph = _file_pair_graph("write", state)

        await graph.ainvoke({"wf:start:input": "seed"})

        assert state["max"] == 1

    @pytest.mark.asyncio
    async def test_parallel_reads_do_not_take_a_lock(self) -> None:
        state = {"active": 0, "max": 0}
        graph = _file_pair_graph("read", state)

        await graph.ainvoke({"wf:start:input": "seed"})

        assert state["max"] == 2

    @pytest.mark.asyncio
    async def test_contended_automatic_lock_times_out_as_workflow_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def _exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {}

        nodes = [
            _start(),
            _data_node("n", NodeType.DATA_FILE, params={"operation": "write", "path": "/mnt/user-data/workspace/a.txt"}),
            _end(),
        ]
        edges = [
            Edge(source="start", source_port="input", target="n", target_port="in"),
            Edge(source="n", source_port="out", target="end", target_port="in"),
        ]
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_FILE] = _exec
        ctx.resource_accessors[NodeType.DATA_FILE] = lambda _rt, _p, _i: (ResourceAccess("wf_test_resource", "test resource", "write"),)
        graph = compile_definition(_def(nodes, edges), context=ctx)

        monkeypatch.setattr("deerflow.workflow.resource_locking.RESOURCE_LOCK_TIMEOUT_SECONDS", 0.2)
        with resource_lock("wf_test_resource"):  # held by this thread; the holder must time out
            with pytest.raises(WorkflowExecutionError, match="test resource"):
                await graph.ainvoke({"wf:start:input": "seed"})

    @pytest.mark.asyncio
    async def test_lock_is_released_when_the_executor_raises(self) -> None:
        access = sandbox_write_access(_runtime("thread-release"))

        with pytest.raises(RuntimeError, match="boom"):
            async with hold_resource_locks([access], timeout=0.2):
                raise RuntimeError("boom")

        with resource_lock(access.key, timeout=0.2):
            pass

    @pytest.mark.asyncio
    async def test_lock_timeout_surfaces_as_resource_lock_error(self) -> None:
        access = sandbox_write_access(_runtime("thread-timeout"))

        with resource_lock(access.key, timeout=0.2):
            with pytest.raises(ResourceLockError, match="sandbox:thread-timeout"):
                async with hold_resource_locks([access], timeout=0.2):
                    pass

    @pytest.mark.asyncio
    async def test_inline_subworkflow_inherits_resource_accessors(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def _exec(_rt: Any, _p: dict, _i: dict) -> dict[str, Any]:
            return {}

        child = WorkflowDefinition(
            id="child",
            name="child",
            nodes=[
                Node(id="cstart", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
                _data_node("cfile", NodeType.DATA_FILE, params={"operation": "write", "path": "/mnt/user-data/workspace/a.txt"}),
                Node(id="cend", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="result", type=PortType.DATA)]),
            ],
            edges=[
                Edge(source="cstart", source_port="in", target="cfile", target_port="in"),
                Edge(source="cfile", source_port="out", target="cend", target_port="in"),
            ],
        )
        sub = Node(
            id="sub",
            type=NodeType.NESTED_SUBWORKFLOW,
            params={
                "subworkflow": {"type": "inline", "definition": child.model_dump(mode="json")},
                "mapping": {"inputs": {"in": "wf:start:input"}, "outputs": {"result": "out"}},
            },
            inputs=[Port(name="in", type=PortType.DATA)],
            outputs=[Port(name="out", type=PortType.DATA)],
        )
        parent = _def(
            [_start(), sub, _end()],
            [
                Edge(source="start", source_port="input", target="sub", target_port="in"),
                Edge(source="sub", source_port="out", target="end", target_port="in"),
            ],
        )
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.DATA_FILE] = _exec
        graph = compile_definition(parent, context=ctx)

        access = sandbox_write_access(_runtime("thread-nested"))
        monkeypatch.setattr("deerflow.workflow.resource_locking.RESOURCE_LOCK_TIMEOUT_SECONDS", 0.2)
        with resource_lock(access.key, timeout=0.2):
            with pytest.raises(WorkflowExecutionError, match="sandbox:thread-nested"):
                await graph.ainvoke(
                    {"wf:start:input": "seed"},
                    {"configurable": {"context": {"thread_id": "thread-nested", "user_id": "user-1"}}},
                )
