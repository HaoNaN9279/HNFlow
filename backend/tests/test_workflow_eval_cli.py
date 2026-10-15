"""Tests for the N14 §24.8 eval CLI (``python -m deerflow.workflow.eval_cli``)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from deerflow.workflow.eval_cli import main
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


def _definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf",
        name="WF",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, inputs=[], outputs=[Port(name="input", type=PortType.DATA)]),
            Node(id="work", type=NodeType.DATA_ASSIGN, inputs=[Port(name="in", type=PortType.DATA)], outputs=[Port(name="out", type=PortType.DATA)]),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)], outputs=[]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="work", target_port="in"),
            Edge(source="work", source_port="out", target="end", target_port="in"),
        ],
    )


async def _record_fixture(path: Path) -> None:
    from deerflow.workflow.compiler import clear_compile_cache, compile_definition
    from deerflow.workflow.executors import build_default_registry
    from deerflow.workflow.replay import MODE_RECORD, REPLAY_CONTEXT_KEY, ReplayFixture, ReplaySession, save_fixture

    clear_compile_cache()
    ctx = build_default_registry().build_context()
    ctx.executors[NodeType.DATA_ASSIGN] = lambda _rt, _p, _i: {"out": "ok"}
    graph = compile_definition(_definition(), context=ctx)
    session = ReplaySession(mode=MODE_RECORD, fixture=ReplayFixture(run_id="r"), redact=False)
    await graph.ainvoke({}, {"configurable": {"thread_id": "t"}, "context": {REPLAY_CONTEXT_KEY: session}})
    save_fixture(path, session.fixture)
    clear_compile_cache()


@pytest.fixture(autouse=True)
def _isolate_cache() -> Any:
    from deerflow.workflow.compiler import clear_compile_cache

    clear_compile_cache()
    yield
    clear_compile_cache()


class TestEvalCli:
    def test_pass_exit_0(self, tmp_path: Path, capsys: Any) -> None:
        from deerflow.workflow.workflow_io import serialize

        definition_path = tmp_path / "def.json"
        definition_path.write_text(serialize(_definition()), encoding="utf-8")
        fixture_path = tmp_path / "fixture.json"
        asyncio.run(_record_fixture(fixture_path))
        cases_path = tmp_path / "cases.json"
        cases_path.write_text(json.dumps([{"name": "smoke", "assertions": [{"node_id": "work", "port": "out", "kind": "equals", "expected": "ok"}]}]), encoding="utf-8")

        code = main(["--definition", str(definition_path), "--fixture", str(fixture_path), "--cases", str(cases_path)])

        assert code == 0
        assert "1/1" in capsys.readouterr().out

    def test_fail_exit_1(self, tmp_path: Path, capsys: Any) -> None:
        from deerflow.workflow.workflow_io import serialize

        definition_path = tmp_path / "def.json"
        definition_path.write_text(serialize(_definition()), encoding="utf-8")
        fixture_path = tmp_path / "fixture.json"
        asyncio.run(_record_fixture(fixture_path))
        cases_path = tmp_path / "cases.json"
        cases_path.write_text(json.dumps([{"name": "bad", "assertions": [{"node_id": "work", "port": "out", "kind": "equals", "expected": "nope"}]}]), encoding="utf-8")

        code = main(["--definition", str(definition_path), "--fixture", str(fixture_path), "--cases", str(cases_path)])

        assert code == 1
        assert "FAIL bad" in capsys.readouterr().out

    def test_bad_inputs_exit_2(self, tmp_path: Path, capsys: Any) -> None:
        code = main(["--definition", str(tmp_path / "missing.json"), "--fixture", str(tmp_path / "missing.json"), "--cases", str(tmp_path / "missing.json")])
        assert code == 2
        assert "cannot load inputs" in capsys.readouterr().err

    def test_json_output(self, tmp_path: Path, capsys: Any) -> None:
        from deerflow.workflow.workflow_io import serialize

        definition_path = tmp_path / "def.json"
        definition_path.write_text(serialize(_definition()), encoding="utf-8")
        fixture_path = tmp_path / "fixture.json"
        asyncio.run(_record_fixture(fixture_path))
        cases_path = tmp_path / "cases.json"
        cases_path.write_text(json.dumps([{"name": "smoke", "assertions": [{"node_id": "work", "port": "out", "kind": "exists"}]}]), encoding="utf-8")

        code = main(["--definition", str(definition_path), "--fixture", str(fixture_path), "--cases", str(cases_path), "--json"])

        assert code == 0
        assert '"total": 1' in capsys.readouterr().out
