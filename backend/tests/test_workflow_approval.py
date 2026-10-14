"""Tests for the N10 human-approval gate (preview → suspend → verify → execute).

Two levels:

1. **Unit** — the decision protocol, the reject policy, manifest re-verification,
   and the task-creation path with ``interrupt`` stubbed (so the create/reuse
   logic and the stored ``output_spec`` can be asserted directly).
2. **End-to-end** — a real compiled graph over ``InMemorySaver``: the node really
   suspends, ``Command(resume=...)`` really resumes it, the executor runs only
   after approval, and a mutated world really blocks the approved action.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from deerflow.config.assets_config import load_assets_config_from_dict, reset_assets_config
from deerflow.workflow.approval import (
    APPROVAL_SNAPSHOT_KIND,
    ApprovalDecision,
    approval_required,
    load_or_create_approval,
    on_reject_policy,
    request_approval,
    run_approval,
    verify_preview_targets,
)
from deerflow.workflow.compiler import WorkflowRuntime, clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.preview import RECOVERY_BACKUP, ActionPreview, declare, make_preview, observe
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate() -> Any:
    clear_compile_cache()
    reset_assets_config()
    yield
    clear_compile_cache()
    reset_assets_config()


def _runtime(context: dict[str, Any] | None = None) -> WorkflowRuntime:
    return WorkflowRuntime(context=context or {}, config={}, state={})


def _preview(**kwargs: Any) -> ActionPreview:
    kwargs.setdefault("action", "import_asset")
    kwargs.setdefault("summary", "Copy a host file into the sandbox")
    kwargs.setdefault("reversible", True)
    kwargs.setdefault("recovery", RECOVERY_BACKUP)
    kwargs.setdefault("node_id", "a1")
    kwargs.setdefault("node_type", "data:asset")
    return make_preview({"node_id": kwargs.pop("node_id"), "node_type": kwargs.pop("node_type")}, **kwargs)


class _FakeRepo:
    """In-memory HumanTask repository double with a real create → find round-trip.

    The round-trip matters: the gate re-reads the stored preview on resume, so a
    repo that forgets its rows would let a stale approval through while a real
    repository (and this double) catches it.
    """

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.create_calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        row: dict[str, Any] = {"id": f"ht-{len(self.create_calls) + 1}", "status": "pending", **kwargs}
        self.create_calls.append(row)
        self.rows[(kwargs["workflow_run_id"], kwargs["node_id"])] = row
        return row

    async def find_by_run_and_node(self, *, run_id: str, node_id: str) -> dict[str, Any] | None:
        return self.rows.get((run_id, node_id))


def _repo() -> _FakeRepo:
    return _FakeRepo()


def _start_node() -> Node:
    return Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)])


def _end_node() -> Node:
    return Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[])


def _asset_node(**params: Any) -> Node:
    return Node(
        id="a1",
        type=NodeType.DATA_ASSET,
        params=params,
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )


def _build_graph(node: Node, checkpointer: Any) -> Any:
    definition = WorkflowDefinition(
        id="approval-wf",
        name="Approval Workflow",
        nodes=[_start_node(), node, _end_node()],
        edges=[
            Edge(source="start", source_port="input", target=node.id, target_port="in"),
            Edge(source=node.id, source_port="out", target="end", target_port="in"),
        ],
    )
    ctx = build_default_registry().build_context()
    ctx.checkpointer = checkpointer
    return compile_definition(definition, context=ctx)


def _config(thread_id: str, repo: _FakeRepo, *, user_id: str = "user-1", run_id: str = "run-1") -> dict[str, Any]:
    return {
        "configurable": {"thread_id": thread_id},
        "context": {"human_task_repo": repo, "user_id": user_id, "run_id": run_id},
    }


def _install_sandbox(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    sandbox = MagicMock()
    sandbox.update_file = MagicMock()
    monkeypatch.setattr("deerflow.workflow.executors.asset.sandbox_tools.ensure_sandbox_initialized", lambda runtime=None: sandbox, raising=True)
    return sandbox


# ── decision protocol ─────────────────────────────────────────────────────────


def test_decision_from_canonical_payload() -> None:
    decision = ApprovalDecision.from_resume({"decision": True, "note": "looks good"}, task_id="ht-1")

    assert decision.approved is True
    assert decision.note == "looks good"
    assert decision.task_id == "ht-1"


def test_decision_accepts_approved_alias() -> None:
    assert ApprovalDecision.from_resume({"approved": True}).approved is True
    assert ApprovalDecision.from_resume({"approved": False}).approved is False


def test_skip_is_a_rejection_never_an_approval() -> None:
    """Declining to decide must not execute an irreversible action."""
    decision = ApprovalDecision.from_resume({"__skip": True})

    assert decision.approved is False
    assert decision.note == "skipped by the user"


@pytest.mark.parametrize("payload", [None, "yes", 1, {}, {"decision": "true"}, {"decision": None}, []])
def test_undecidable_payloads_reject(payload: Any) -> None:
    assert ApprovalDecision.from_resume(payload).approved is False


# ── policy ────────────────────────────────────────────────────────────────────


def test_approval_required_only_for_explicit_true() -> None:
    assert approval_required({"require_approval": True}) is True
    assert approval_required({"require_approval": False}) is False
    assert approval_required({"require_approval": "yes"}) is False
    assert approval_required({}) is False


def test_on_reject_defaults_to_fail() -> None:
    assert on_reject_policy({}) == "fail"
    assert on_reject_policy({"on_reject": "skip"}) == "skip"
    with pytest.raises(WorkflowExecutionError, match="on_reject must be one of"):
        on_reject_policy({"on_reject": "explode"})


# ── manifest re-verification ──────────────────────────────────────────────────


def test_verify_targets_flags_a_changed_source(tmp_path: Path) -> None:
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"approved-content")
    preview = _preview(sources=[observe(_fingerprint(source))])

    source.write_bytes(b"someone-else-content")
    notes = verify_preview_targets(preview)

    assert len(notes) == 1
    assert "content changed" in notes[0]


def test_verify_targets_flags_a_changed_target(tmp_path: Path) -> None:
    target = tmp_path / "out.obj"
    target.write_bytes(b"v1")
    preview = _preview(targets=[observe(_fingerprint(target))])

    target.write_bytes(b"v2")
    assert verify_preview_targets(preview) != []


def test_verify_targets_ignores_declared_targets(tmp_path: Path) -> None:
    preview = _preview(targets=[declare(_fingerprint(tmp_path / "never-touched"))])

    assert verify_preview_targets(preview) == []


def test_verify_targets_returns_empty_when_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"content")
    preview = _preview(sources=[observe(_fingerprint(source))])

    assert verify_preview_targets(preview) == []


def _fingerprint(path: Path) -> Any:
    """A host ref fingerprinted the way a previewer with ``hash`` enabled does."""
    from deerflow.assets.ref import make_ref
    from deerflow.workflow.preview import fingerprint_host_ref

    return fingerprint_host_ref(make_ref(str(path), scope="host", sha256="0" * 64))


# ── task creation (interrupt stubbed) ─────────────────────────────────────────


def test_request_approval_creates_an_approval_task(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _repo()
    monkeypatch.setattr("deerflow.workflow.approval.interrupt", lambda payload: {"decision": True})

    decision = asyncio.run(request_approval(_runtime({"human_task_repo": repo, "user_id": "u", "run_id": "r"}), node_id="a1", node_type="data:asset", preview=_preview()))

    assert decision.approved is True
    assert decision.task_id == "ht-1"
    kwargs = repo.create_calls[0]
    assert kwargs["node_id"] == "a1"
    assert kwargs["user_id"] == "u"
    assert kwargs["workflow_run_id"] == "r"
    assert kwargs["inputs_snapshot"]["kind"] == APPROVAL_SNAPSHOT_KIND
    assert kwargs["inputs_snapshot"]["preview"]["action"] == "import_asset"
    # The shared HumanTask submission validator must accept a plain bool.
    assert kwargs["output_spec"]["ports"][0]["name"] == "decision"
    assert kwargs["validation_rules"] == {"enum": {"decision": {"enum": [True, False]}}}
    assert kwargs["checkpoint_ref"] is None
    assert kwargs["description"].startswith("[approval] ")


def test_request_approval_reuses_an_existing_task(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resume re-executes the node — a duplicate pending approval must not be minted."""
    repo = _repo()
    repo.rows[("r", "a1")] = {"id": "ht-existing", "inputs_snapshot": {"kind": APPROVAL_SNAPSHOT_KIND, "preview": _preview().to_port()}}
    monkeypatch.setattr("deerflow.workflow.approval.interrupt", lambda payload: {"decision": True})

    decision = asyncio.run(request_approval(_runtime({"human_task_repo": repo, "run_id": "r"}), node_id="a1", node_type="data:asset", preview=_preview()))

    assert decision.task_id == "ht-existing"
    assert repo.create_calls == []


def test_load_or_create_approval_returns_the_stored_preview_on_resume() -> None:
    """The approval is about the snapshot the human saw, not a fresh one."""
    repo = _repo()
    stored = _preview(summary="the original action")
    repo.rows[("r", "a1")] = {"id": "ht-existing", "inputs_snapshot": {"kind": APPROVAL_SNAPSHOT_KIND, "preview": stored.to_port()}}

    def _previewer(runtime: Any, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:  # pragma: no cover — must not run
        raise AssertionError("the previewer must not run again once an approval exists")

    record = asyncio.run(load_or_create_approval(_runtime({"human_task_repo": repo, "run_id": "r"}), node_id="a1", node_type="data:asset", previewer=_previewer, params={}, inputs={}))

    assert record.task_id == "ht-existing"
    assert record.preview.summary == "the original action"
    assert repo.create_calls == []


def test_load_or_create_approval_reuses_a_row_without_a_preview() -> None:
    """A row whose snapshot is unreadable still owns the decision — do not duplicate it."""
    repo = _repo()
    repo.rows[("r", "a1")] = {"id": "ht-legacy", "inputs_snapshot": {}}

    def _previewer(runtime: Any, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:
        return _preview()

    record = asyncio.run(load_or_create_approval(_runtime({"human_task_repo": repo, "run_id": "r"}), node_id="a1", node_type="data:asset", previewer=_previewer, params={}, inputs={}))

    assert record.task_id == "ht-legacy"
    assert repo.create_calls == []


def test_request_approval_without_repo_is_explicit() -> None:
    with pytest.raises(WorkflowExecutionError, match="human_task_repo"):
        asyncio.run(request_approval(_runtime(), node_id="a1", node_type="data:asset", preview=_preview()))


def test_run_approval_reports_a_previewer_that_declares_nothing() -> None:
    def _no_preview(runtime: Any, params: dict[str, Any], inputs: dict[str, Any]) -> None:
        return None

    with pytest.raises(WorkflowExecutionError, match="declared nothing to preview"):
        asyncio.run(run_approval(_runtime({"human_task_repo": _repo()}), node_id="a1", node_type="data:asset", previewer=_no_preview, params={}, inputs={}))


def test_run_approval_does_not_verify_a_rejected_action(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"content")
    repo = _repo()
    monkeypatch.setattr("deerflow.workflow.approval.interrupt", lambda payload: {"decision": False, "note": "not now"})

    def _previewer(runtime: Any, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:
        return _preview(sources=[observe(_fingerprint(source))])

    source.write_bytes(b"changed")
    decision = asyncio.run(run_approval(_runtime({"human_task_repo": repo}), node_id="a1", node_type="data:asset", previewer=_previewer, params={}, inputs={}))

    assert decision.approved is False
    assert decision.note == "not now"


def test_run_approval_blocks_a_stale_approved_action(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "chair.fbx"
    source.write_bytes(b"content")
    repo = _repo()

    def _interrupt_and_mutate(payload: dict[str, Any]) -> dict[str, Any]:
        # The human approves — but between the preview and the decision someone
        # rewrote the file the approval was about.
        source.write_bytes(b"different")
        return {"decision": True}

    monkeypatch.setattr("deerflow.workflow.approval.interrupt", _interrupt_and_mutate)

    def _previewer(runtime: Any, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview:
        return _preview(sources=[observe(_fingerprint(source))])

    with pytest.raises(WorkflowExecutionError, match="no longer valid"):
        asyncio.run(run_approval(_runtime({"human_task_repo": repo}), node_id="a1", node_type="data:asset", previewer=_previewer, params={}, inputs={}))


# ── compile-time validation ───────────────────────────────────────────────────


def test_require_approval_on_a_readonly_node_is_a_compile_error() -> None:
    node = Node(
        id="w1",
        type=NodeType.FLOW_WAIT,
        params={"require_approval": True, "seconds": 0},
        inputs=[Port(name="in", type=PortType.DATA)],
        outputs=[Port(name="out", type=PortType.DATA)],
    )
    definition = WorkflowDefinition(
        id="bad-wf",
        name="Bad",
        nodes=[_start_node(), node, _end_node()],
        edges=[
            Edge(source="start", source_port="input", target="w1", target_port="in"),
            Edge(source="w1", source_port="out", target="end", target_port="in"),
        ],
    )
    with pytest.raises(Exception, match="require_approval is not supported"):
        compile_definition(definition, context=build_default_registry().build_context())


def test_bad_on_reject_is_a_compile_error() -> None:
    node = _asset_node(operation="import", path="/tmp/a.fbx", crash_confirm=True, require_approval=True, on_reject="explode")
    with pytest.raises(Exception, match="on_reject must be 'fail' or 'skip'"):
        _build_graph(node, InMemorySaver())


# ── end-to-end: real suspend / resume ─────────────────────────────────────────


class TestApprovalEndToEnd:
    def test_node_does_not_run_before_approval(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())
        repo = _repo()
        config = _config("t-suspend", repo)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            return await graph.aget_state(config)

        state = asyncio.run(_run())

        assert state.next == ("a1",), f"expected suspension at a1, got {state.next}"
        assert len(repo.create_calls) == 1
        assert repo.create_calls[0]["inputs_snapshot"]["preview"]["action"] == "import_asset"
        sandbox.update_file.assert_not_called()  # nothing ran yet

    def test_approval_lets_the_node_run(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())
        repo = _repo()
        config = _config("t-approve", repo)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"decision": True}), config)
            return await graph.aget_state(config)

        state = asyncio.run(_run())

        assert state.next == ()
        sandbox.update_file.assert_called_once()
        assert state.values.get("wf:a1:out")["path"] == "/mnt/user-data/workspace/chair.fbx"

    def test_rejection_fails_the_node(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())
        repo = _repo()
        config = _config("t-reject-fail", repo)

        async def _run() -> None:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"decision": False, "note": "wrong file"}), config)

        with pytest.raises(WorkflowExecutionError, match="rejected by the approver: wrong file"):
            asyncio.run(_run())
        sandbox.update_file.assert_not_called()

    def test_rejection_can_skip_instead(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        node = _asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True, on_reject="skip")
        graph = _build_graph(node, InMemorySaver())
        repo = _repo()
        config = _config("t-reject-skip", repo)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"decision": False}), config)
            return await graph.aget_state(config)

        state = asyncio.run(_run())

        assert state.next == ()  # the graph continues past the skipped node
        assert state.values.get("wf:a1:out") is None
        sandbox.update_file.assert_not_called()

    def test_resume_without_a_decision_rejects(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """A resume payload that carries no decision must not approve."""
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())
        repo = _repo()
        config = _config("t-garbage", repo)

        async def _run() -> None:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            await graph.ainvoke(Command(resume={"note": "hmm"}), config)

        with pytest.raises(WorkflowExecutionError, match="rejected by the approver"):
            asyncio.run(_run())
        sandbox.update_file.assert_not_called()

    def test_stale_source_blocks_the_approved_node(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())
        repo = _repo()
        config = _config("t-stale", repo)

        async def _run() -> None:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            source.write_bytes(b"the human re-exported it while deciding")
            await graph.ainvoke(Command(resume={"decision": True}), config)

        with pytest.raises(WorkflowExecutionError, match="no longer valid"):
            asyncio.run(_run())
        sandbox.update_file.assert_not_called()

    def test_missing_repo_is_explicit(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True, require_approval=True), InMemorySaver())

        async def _run() -> None:
            await graph.ainvoke({"wf:start:input": "go"}, {"configurable": {"thread_id": "t-norepo"}})

        with pytest.raises(WorkflowExecutionError, match="human_task_repo"):
            asyncio.run(_run())

    def test_without_require_approval_the_node_runs_directly(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        load_assets_config_from_dict({"roots": [str(tmp_path)]})
        sandbox = _install_sandbox(monkeypatch)
        source = tmp_path / "chair.fbx"
        source.write_bytes(b"payload")
        graph = _build_graph(_asset_node(operation="import", path=str(source), crash_confirm=True), InMemorySaver())
        repo = _repo()
        config = _config("t-no-approval", repo)

        async def _run() -> Any:
            await graph.ainvoke({"wf:start:input": "go"}, config)
            return await graph.aget_state(config)

        state = asyncio.run(_run())

        assert state.next == ()
        sandbox.update_file.assert_called_once()
        assert repo.create_calls == []
