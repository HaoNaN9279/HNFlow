"""Tests for the ``human:task`` executor and its compiler injection.

Covers T13-1 acceptance criteria:

1. Missing ``human_task_repo`` in runtime context → ``WorkflowExecutionError``
   with the node id in the message (subgraph / no-repository degradation).
2. Real-graph spike: a compiled ``start → human:task → end`` graph with an
   ``InMemorySaver`` creates a pending HumanTask via a mock repo and suspends
   via ``interrupt()`` (``aget_state(config).next`` non-empty).
3. ``Command(resume={"answer": "hi"})`` resumes the same thread; the
   ``human:task`` output port receives ``{"answer": "hi"}``.
4. ``Command(resume={"__skip": True})`` resumes; the output port stays unset.
5. Compiler injection: a ``HUMAN_TASK`` node's executor receives ``node_id``
   and a derived ``output_spec``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.workflow.compiler import WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry, exec_human_task
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (mirror compiler / executor test helpers)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(nodes: list[Node] | None = None, edges: list[Edge] | None = None, **kwargs: Any) -> WorkflowDefinition:
    kwargs.setdefault("id", "test-wf")
    kwargs.setdefault("name", "Test Workflow")
    return WorkflowDefinition(nodes=nodes or [], edges=edges or [], **kwargs)


def _start_node(id_: str = "start") -> Node:
    return Node(id=id_, type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node(id_: str = "end") -> Node:
    return Node(id=id_, type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _human_node(id_: str = "ht") -> Node:
    return Node(
        id=id_,
        type=NodeType.HUMAN_TASK,
        params={},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="answer", type=PortType.DATA)],
    )


def _build_human_graph(checkpointer: Any) -> tuple[Any, Node]:
    """Compile ``start → human:task → end`` with the real ``exec_human_task``."""
    nodes = [_start_node(), _human_node(), _end_node()]
    edges = [
        Edge(source="start", source_port="input", target="ht", target_port="in"),
        Edge(source="ht", source_port="answer", target="end", target_port="in"),
    ]
    definition = _make_def(nodes, edges)
    ctx = build_default_registry().build_context()
    ctx.checkpointer = checkpointer
    graph = compile_definition(definition, context=ctx)
    return graph, definition


def _make_repo() -> AsyncMock:
    repo = AsyncMock()
    repo.create = AsyncMock(return_value={"id": "ht-test"})
    repo.find_by_run_and_node = AsyncMock(return_value=None)
    return repo


def _make_stateful_repo() -> AsyncMock:
    """A mock repo that persists create() results and replays them via find_by_run_and_node.

    Simulates the real repository's create → find round-trip so idempotency tests
    can assert that a resume re-execution reuses the existing task (create count
    stays at 1).
    """
    repo = AsyncMock()
    store: dict[tuple[str, str], dict[str, Any]] = {}
    create_calls: list[dict[str, Any]] = []

    async def _create(**kwargs: Any) -> dict[str, Any]:
        task: dict[str, Any] = {"id": f"ht-{len(create_calls) + 1}", "status": "pending", **kwargs}
        create_calls.append(task)
        store[(kwargs["workflow_run_id"], kwargs["node_id"])] = task
        return task

    async def _find_by_run_and_node(*, run_id: str, node_id: str) -> dict[str, Any] | None:
        return store.get((run_id, node_id))

    repo.create = AsyncMock(side_effect=_create)
    repo.find_by_run_and_node = AsyncMock(side_effect=_find_by_run_and_node)
    return repo


def _config(thread_id: str, repo: AsyncMock, user_id: str = "user-1", run_id: str = "run-1") -> dict[str, Any]:
    return {
        "configurable": {"thread_id": thread_id},
        "context": {"human_task_repo": repo, "user_id": user_id, "run_id": run_id},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    clear_compile_cache()
    yield


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Missing repo → explicit degradation
# ═══════════════════════════════════════════════════════════════════════════════


class TestMissingRepo:
    @pytest.mark.asyncio
    async def test_missing_repo_raises_with_node_id(self) -> None:
        rt = WorkflowRuntime(context={})
        with pytest.raises(WorkflowExecutionError) as exc_info:
            await exec_human_task(rt, {"node_id": "ht-1"}, {})
        message = str(exc_info.value)
        assert "ht-1" in message
        assert "human_task_repo" in message
        assert "human task requires a human_task_repo in runtime context" in message


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Real-graph spike — create + interrupt suspension
# ═══════════════════════════════════════════════════════════════════════════════


class TestSuspend:
    @pytest.mark.asyncio
    async def test_creates_todo_and_suspends(self) -> None:
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_repo()
        config = _config("thread-suspend", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)

        # The repo.create must have been called with the right arguments.
        repo.create.assert_called_once()
        kwargs = repo.create.call_args.kwargs
        assert kwargs["user_id"] == "user-1"
        assert kwargs["workflow_run_id"] == "run-1"
        assert kwargs["node_id"] == "ht"
        assert kwargs["inputs_snapshot"] == {"in": "go"}
        assert kwargs["output_spec"] == {"ports": [{"name": "answer", "type": "data", "required": False, "description": None}]}
        assert kwargs["checkpoint_ref"] is None

        # The graph must be suspended (pending task = the interrupted node).
        state = await graph.aget_state(config)
        assert state.next == ("ht",), f"Expected suspended at 'ht', got {state.next}"


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Resume — submit and skip
# ═══════════════════════════════════════════════════════════════════════════════


class TestResume:
    @pytest.mark.asyncio
    async def test_resume_submit_returns_output_port(self) -> None:
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_repo()
        config = _config("thread-resume-submit", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)

        await graph.ainvoke(Command(resume={"answer": "hi"}), config)

        state = await graph.aget_state(config)
        assert state.next == (), f"Expected graph to finish after resume, got {state.next}"
        assert state.values.get("wf:ht:answer") == "hi"

    @pytest.mark.asyncio
    async def test_resume_skip_leaves_output_unset(self) -> None:
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_repo()
        config = _config("thread-resume-skip", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)

        await graph.ainvoke(Command(resume={"__skip": True}), config)

        state = await graph.aget_state(config)
        assert state.next == (), f"Expected graph to finish after skip, got {state.next}"
        assert state.values.get("wf:ht:answer") is None

    @pytest.mark.asyncio
    async def test_resume_ignores_undeclared_ports(self) -> None:
        """Resume values for ports not declared on the node are dropped."""
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_repo()
        config = _config("thread-resume-undeclared", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)

        await graph.ainvoke(Command(resume={"answer": "hi", "extra": "drop-me"}), config)

        state = await graph.aget_state(config)
        assert state.values.get("wf:ht:answer") == "hi"
        # "extra" is not a declared output port → never written to state.
        assert "wf:ht:extra" not in state.values


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Compiler injection
# ═══════════════════════════════════════════════════════════════════════════════


class TestCompilerInjection:
    @pytest.mark.asyncio
    async def test_human_task_executor_receives_node_id_and_output_spec(self) -> None:
        captured: dict[str, Any] = {}

        def capture_executor(_runtime: WorkflowRuntime, params: dict[str, Any], _inputs: dict[str, Any]) -> dict[str, Any]:
            captured.update(params)
            return {}

        nodes = [_start_node(), _human_node("ht_node"), _end_node()]
        edges = [
            Edge(source="start", source_port="input", target="ht_node", target_port="in"),
            Edge(source="ht_node", source_port="answer", target="end", target_port="in"),
        ]
        definition = _make_def(nodes, edges)
        ctx = build_default_registry().build_context()
        ctx.executors[NodeType.HUMAN_TASK] = capture_executor
        graph = compile_definition(definition, context=ctx)

        await graph.ainvoke({"wf:start:input": "go"})

        assert captured["node_id"] == "ht_node"
        assert captured["output_spec"] == {"ports": [{"name": "answer", "type": "data", "required": False, "description": None}]}


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Idempotency (T13-4) — resume must not re-create the pending task
# ═══════════════════════════════════════════════════════════════════════════════


class TestIdempotency:
    @pytest.mark.asyncio
    async def test_resume_reuses_existing_task_create_called_once(self) -> None:
        """Resume re-executes the node from the head; create must fire only once.

        The first execution creates ht-1; the resume's re-execution hits
        ``find_by_run_and_node`` and reuses ht-1 instead of creating ht-2.
        """
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_stateful_repo()
        config = _config("thread-idem", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)
        assert repo.create.await_count == 1

        await graph.ainvoke(Command(resume={"answer": "hi"}), config)

        state = await graph.aget_state(config)
        assert state.next == (), f"Expected graph to finish after resume, got {state.next}"
        assert state.values.get("wf:ht:answer") == "hi"
        assert repo.create.await_count == 1, f"resume re-created a task: create called {repo.create.await_count} times"

    @pytest.mark.asyncio
    async def test_resume_reuses_submitted_task(self) -> None:
        """Resume reuses the already-submitted task (find returns a submitted row)."""
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_stateful_repo()
        config = _config("thread-idem-submitted", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)

        # Simulate the real timing: the original task is submitted before resume.
        created = repo.create.await_args_list[0].kwargs
        repo.find_by_run_and_node.side_effect = AsyncMock(return_value={"id": "ht-1", "status": "submitted", **created})

        await graph.ainvoke(Command(resume={"answer": "hi"}), config)

        state = await graph.aget_state(config)
        assert state.next == ()
        assert state.values.get("wf:ht:answer") == "hi"
        assert repo.create.await_count == 1

    @pytest.mark.asyncio
    async def test_skip_resume_reuses_existing_task(self) -> None:
        """Skip resume also reuses the existing task (no duplicate create)."""
        saver = InMemorySaver()
        graph, _ = _build_human_graph(saver)
        repo = _make_stateful_repo()
        config = _config("thread-idem-skip", repo)

        await graph.ainvoke({"wf:start:input": "go"}, config)
        assert repo.create.await_count == 1

        await graph.ainvoke(Command(resume={"__skip": True}), config)

        state = await graph.aget_state(config)
        assert state.next == ()
        assert state.values.get("wf:ht:answer") is None
        assert repo.create.await_count == 1
