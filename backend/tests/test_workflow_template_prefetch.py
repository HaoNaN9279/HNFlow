"""Tests for the app-layer workflow-template transitive-closure prefetch (T9-3).

Covers the ``app.gateway.services`` helpers that load every template reachable
from a workflow definition into a dict and build a synchronous resolver closure:

- Multi-level template chain A→B→C resolves without a false ``not found``.
- Inline subgraph internals are scanned for template references.
- The resolver closure is a pure synchronous dict lookup (no coroutine).
- Missing templates are skipped by prefetch (resolver returns None later).
- Fail-open: a repo error degrades to ``None`` resolver, not a raised exception.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from app.gateway.services import (
    _build_workflow_template_resolver,
    _collect_template_refs,
    _make_template_resolver,
    _prefetch_workflow_templates,
)
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _template_def(tid: str, *, template_id: str | None = None, inline: dict[str, Any] | None = None) -> WorkflowDefinition:
    """Build a template definition whose single nested node references a template or inline child."""
    nodes: list[Node] = [
        Node(id=f"{tid}_start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="in", type=PortType.DATA)]),
    ]
    edges: list[Edge] = []
    if template_id is not None or inline is not None:
        spec: dict[str, Any]
        if template_id is not None:
            spec = {"type": "template", "template_id": template_id}
        else:
            spec = {"type": "inline", "definition": inline}
        nodes.append(
            Node(
                id=f"{tid}_sub",
                type=NodeType.NESTED_SUBWORKFLOW,
                params={"subworkflow": spec},
                inputs=[Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="out", type=PortType.DATA)],
            )
        )
        edges.append(Edge(source=f"{tid}_start", source_port="in", target=f"{tid}_sub", target_port="in"))
    nodes.append(Node(id=f"{tid}_end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]))
    if nodes[-2].id.endswith("_sub"):
        edges.append(Edge(source=f"{tid}_sub", source_port="out", target=f"{tid}_end", target_port="in"))
    elif len(nodes) == 2:
        edges.append(Edge(source=f"{tid}_start", source_port="in", target=f"{tid}_end", target_port="in"))
    return WorkflowDefinition(id=tid, name=tid, nodes=nodes, edges=edges)


class _MockRepo:
    """Async repo whose ``get`` returns a row dict from a canned mapping."""

    def __init__(self, rows: dict[str, dict[str, Any]]) -> None:
        self._rows = rows
        self.calls: list[str] = []

    async def get(self, definition_id: str, *, user_id: str) -> dict[str, Any] | None:
        self.calls.append(definition_id)
        return self._rows.get(definition_id)


def _row(def_: WorkflowDefinition) -> dict[str, Any]:
    return {"id": def_.id, "definition": def_.model_dump(mode="json"), "version": "0.1.0"}


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Multi-level template chain
# ═══════════════════════════════════════════════════════════════════════════════


class TestMultiLevelChain:
    @pytest.mark.asyncio
    async def test_chain_abc_all_resolved(self) -> None:
        """top → A → B → C, every level loaded, no false not-found."""
        c = _template_def("C")  # no further refs
        b = _template_def("B", template_id="C")
        a = _template_def("A", template_id="B")
        top = _template_def("top", template_id="A")

        repo = _MockRepo({"A": _row(a), "B": _row(b), "C": _row(c)})
        result = await _prefetch_workflow_templates(top, repo, user_id="user-1")

        assert set(result) == {"top", "A", "B", "C"}
        assert result["top"] is top
        assert result["A"].id == "A"
        assert result["B"].id == "B"
        assert result["C"].id == "C"
        # repo.get was consulted exactly once per referenced template
        assert set(repo.calls) == {"A", "B", "C"}


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Inline subgraph internals scanned
# ═══════════════════════════════════════════════════════════════════════════════


class TestInlineNested:
    def test_inline_subgraph_template_ref_collected(self) -> None:
        """An inline child whose inner node references a template is collected."""
        inline_def: dict[str, Any] = {
            "id": "inline-child",
            "name": "inline-child",
            "nodes": [
                {"id": "cstart", "type": "flow:start", "outputs": [{"name": "in", "type": "data"}]},
                {
                    "id": "csub",
                    "type": "nested:subworkflow",
                    "params": {"subworkflow": {"type": "template", "template_id": "leaf-template"}},
                    "inputs": [{"name": "in", "type": "data"}],
                    "outputs": [{"name": "out", "type": "data"}],
                },
                {"id": "cend", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
            ],
            "edges": [],
        }
        top = _template_def("top", inline=inline_def)

        assert _collect_template_refs(top) == {"leaf-template"}


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Resolver closure is synchronous
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolverClosure:
    def test_resolver_is_sync_dict_lookup(self) -> None:
        """resolver("x") returns a WorkflowDefinition (or None), never a coroutine."""
        a = _template_def("A")
        resolver = _make_template_resolver({"A": a})

        hit = resolver("A")
        assert hit is a
        assert not inspect.isawaitable(hit)

        assert resolver("missing") is None

        # Two-argument form (template_id, version) is accepted.
        assert resolver("A", "0.1.0") is a


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Missing templates skipped + fail-open
# ═══════════════════════════════════════════════════════════════════════════════


class TestMissingAndFailOpen:
    @pytest.mark.asyncio
    async def test_missing_template_skipped(self) -> None:
        """A referenced template absent from the repo is skipped, not an error."""
        a = _template_def("A", template_id="B")
        top = _template_def("top", template_id="A")
        repo = _MockRepo({"A": _row(a)})  # B missing

        result = await _prefetch_workflow_templates(top, repo, user_id="user-1")
        assert set(result) == {"top", "A"}
        assert "B" not in result

    @pytest.mark.asyncio
    async def test_repo_error_degrades_to_none_resolver(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """get_workflow_definition_repo raising → resolver None (fail-open)."""
        from app.gateway import services as svc

        class _BoomRepo:
            async def get(self, definition_id: str, *, user_id: str) -> dict[str, Any] | None:
                raise RuntimeError("db down")

        monkeypatch.setattr(svc, "get_workflow_definition_repo", lambda _request: _BoomRepo())

        top = _template_def("top", template_id="A")
        request: Any = object()

        resolver = await _build_workflow_template_resolver(top, request, user_id="user-1")
        assert resolver is None

    @pytest.mark.asyncio
    async def test_no_user_id_returns_none(self) -> None:
        top = _template_def("top", template_id="A")
        resolver = await _build_workflow_template_resolver(top, object(), user_id=None)  # type: ignore[arg-type]
        assert resolver is None
