"""A real workflow worker must create HumanTasks owned by the run owner.

The executor-level tests inject ``user_id`` directly; this test goes through
``run_workflow`` so the runtime-context assembly is what is being verified.
"""

from __future__ import annotations

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.runtime.events.store.memory import MemoryRunEventStore
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext
from deerflow.runtime.stream_bridge.memory import MemoryStreamBridge
from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition
from deerflow.workflow.worker import run_workflow


class _RecordingRepo:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def find_by_run_and_node(self, *, run_id: str, node_id: str):
        return None

    async def create(self, **kwargs):
        self.rows.append(kwargs)
        return {"id": "ht-1", **kwargs}

    async def update_checkpoint_ref_by_run(self, **_kwargs) -> None:
        return None

    async def delete_pending_by_run(self, **_kwargs) -> None:
        return None


def _human_definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf-human-worker",
        name="human worker",
        nodes=[
            Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="input", type=PortType.DATA)]),
            Node(
                id="human",
                type=NodeType.HUMAN_TASK,
                inputs=[Port(name="in", type=PortType.DATA)],
                outputs=[Port(name="answer", type=PortType.DATA)],
                params={"description": "review"},
            ),
            Node(id="end", type=NodeType.FLOW_END, inputs=[Port(name="in", type=PortType.DATA)]),
        ],
        edges=[
            Edge(source="start", source_port="input", target="human", target_port="in"),
            Edge(source="human", source_port="answer", target="end", target_port="in"),
        ],
    )


@pytest.mark.asyncio
async def test_worker_creates_human_task_for_run_owner() -> None:
    manager = RunManager()
    bridge = MemoryStreamBridge()
    event_store = MemoryRunEventStore()
    repo = _RecordingRepo()
    ctx = RunContext(checkpointer=InMemorySaver(), event_store=event_store)
    record = await manager.create("wf-human-thread", assistant_id="wf-human-worker", user_id="default")

    await run_workflow(
        bridge,
        manager,
        record,
        ctx=ctx,
        definition=_human_definition(),
        params={"input": "x"},
        human_task_repo=repo,
    )

    assert record.status is RunStatus.interrupted
    assert len(repo.rows) == 1
    assert repo.rows[0]["user_id"] == "default"
    assert repo.rows[0]["workflow_run_id"] == record.run_id
    assert repo.rows[0]["node_id"] == "human"
