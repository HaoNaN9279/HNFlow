"""End-to-end: an app-node workflow compiles and executes (N4+N5, S4).

Wires ``start → app:launch → app:script → app:wait → app:collect → end``
through the real compiler + default executor registry, using the mock driver
and the process-wide session manager (no runtime context injected — exercises
the executor's singleton fallback).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.apps.session import reset_session_manager
from deerflow.config.apps_config import load_apps_config_from_dict, reset_apps_config
from deerflow.workflow.compiler import clear_compile_cache, compile_definition
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition


@pytest.fixture(autouse=True)
def _isolate():
    clear_compile_cache()
    yield
    reset_apps_config()
    reset_session_manager()


def _definition(tmp_path: Path) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf-apps",
        name="App workflow",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)]),
            Node(
                id="launch",
                type=NodeType.APP_LAUNCH,
                inputs=[Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="session", type=PortType.DATA), Port(name="out", type=PortType.DATA)],
                params={"app": "demo", "crash_confirm": True},
            ),
            Node(
                id="script",
                type=NodeType.APP_SCRIPT,
                inputs=[Port(name="session", type=PortType.DATA), Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="session", type=PortType.DATA), Port(name="out", type=PortType.DATA)],
                params={"app": "demo", "script": "render", "crash_confirm": True},
            ),
            Node(
                id="wait",
                type=NodeType.APP_WAIT,
                inputs=[Port(name="session", type=PortType.DATA), Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="session", type=PortType.DATA), Port(name="out", type=PortType.DATA)],
                params={"app": "demo", "for": "render"},
            ),
            Node(
                id="collect",
                type=NodeType.APP_COLLECT,
                inputs=[Port(name="session", type=PortType.DATA), Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="session", type=PortType.DATA), Port(name="out", type=PortType.FILE)],
                params={"app": "demo"},
            ),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.FILE)]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="launch", target_port="in"),
            Edge(source="launch", source_port="session", target="script", target_port="session"),
            Edge(source="launch", source_port="out", target="script", target_port="in"),
            Edge(source="script", source_port="session", target="wait", target_port="session"),
            Edge(source="script", source_port="out", target="wait", target_port="in"),
            Edge(source="wait", source_port="session", target="collect", target_port="session"),
            Edge(source="wait", source_port="out", target="collect", target_port="in"),
            Edge(source="collect", source_port="out", target="end", target_port="in"),
        ],
    )


def test_app_workflow_compiles_and_executes(tmp_path: Path):
    load_apps_config_from_dict({"enabled": True, "definitions": {"demo": {"driver": "mock", "description": "demo", "working_dir": str(tmp_path)}}})
    reset_session_manager()

    ctx = build_default_registry().build_context()
    graph = compile_definition(_definition(tmp_path), context=ctx)

    import asyncio

    state = asyncio.run(graph.ainvoke({}))

    assert state["wf:script:out"]["status"] == "completed"
    assert state["wf:wait:out"]["status"] == "done"
    assert Path(state["wf:collect:out"]).name == "mock-output.txt"
    assert state["wf:launch:session"]["app_name"] == "demo"
