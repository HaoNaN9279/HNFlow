"""Multi-agent topology templates (N14 §24.6b / §24.6a).

Two collaboration shapes recur often enough to ship as reusable builders rather
than hand-wired graphs:

- **bounded review loop** (§24.6a): a producer generates, a critic reviews, and
  the loop repeats until the critic stops asking for revision or the iteration
  cap is hit.  Expressed entirely with existing primitives — ``flow:loop`` with
  ``params.continue_on`` reading the critic's verdict — so there is no new engine
  behaviour, only a named shape.
- **supervisor topology** (§24.6b): a supervisor picks one of a set of expert
  nodes at runtime (``flow:switch`` over the supervisor's ``decision`` port),
  the expert runs, and the graph ends.

Both return a plain :class:`WorkflowDefinition` (serialisable, compilable).  The
canvas can insert one as a starting point; the builders are pure and offline-testable.
"""

from __future__ import annotations

from deerflow.workflow.schema import Edge, Node, NodeType, Port, PortType, WorkflowDefinition

_START_ID = "start"
_END_ID = "end"


def _port(name: str, type_: PortType = PortType.DATA, required: bool = False) -> Port:
    return Port(name=name, type=type_, required=required)


def _start() -> Node:
    return Node(id=_START_ID, type=NodeType.FLOW_START, inputs=[], outputs=[_port("input")])


def _end() -> Node:
    return Node(id=_END_ID, type=NodeType.FLOW_END, inputs=[_port("in")], outputs=[])


def critic_review_loop(
    *,
    producer_instruction: str,
    critic_instruction: str,
    max_iterations: int = 3,
    definition_id: str = "critic-review-loop",
    name: str = "Critic Review Loop",
) -> WorkflowDefinition:
    """A producer ↔ critic loop bounded by *max_iterations* (§24.6a).

    The ``flow:loop`` node continues while the critic's ``needs_revision`` port
    is truthy and ``iterations`` is not exhausted; the producer and critic are
    ``ai:llm_agent`` nodes carrying the supplied instructions.  The final draft
    leaves on the loop's ``out`` port.
    """
    if max_iterations < 1:
        raise ValueError("max_iterations must be >= 1")
    nodes = [
        _start(),
        Node(
            id="review_loop",
            type=NodeType.FLOW_LOOP,
            params={"iterations": max_iterations, "continue_on": "needs_revision"},
            inputs=[_port("in")],
            outputs=[_port("iteration"), _port("out")],
        ),
        Node(id="producer", type=NodeType.AI_LLM_AGENT, params={"instruction": producer_instruction}, inputs=[_port("in")], outputs=[_port("out")]),
        Node(
            id="critic",
            type=NodeType.AI_LLM_AGENT,
            params={"instruction": critic_instruction},
            inputs=[_port("in")],
            # Declared ``data`` (not ``bool``): the verdict flows back along the
            # loop's ``in`` port, and a port declaration must match the target.
            outputs=[_port("out"), _port("needs_revision")],
        ),
        _end(),
    ]
    edges = [
        Edge(source=_START_ID, source_port="input", target="review_loop", target_port="in"),
        # Loop body (conditional) + exit (default).
        Edge(source="review_loop", source_port="out", target="producer", target_port="in", condition="loop_body"),
        Edge(source="review_loop", source_port="out", target=_END_ID, target_port="in"),
        Edge(source="producer", source_port="out", target="critic", target_port="in"),
        # Back-edge carrying the critic's verdict into the loop's continue check.
        Edge(source="critic", source_port="needs_revision", target="review_loop", target_port="in"),
    ]
    return WorkflowDefinition(id=definition_id, name=name, nodes=nodes, edges=edges)


def supervisor_topology(
    *,
    supervisor_instruction: str,
    experts: list[tuple[str, str]],
    definition_id: str = "supervisor-topology",
    name: str = "Supervisor Topology",
) -> WorkflowDefinition:
    """A supervisor dispatches to one of *experts* at runtime (§24.6b).

    ``experts`` is a list of ``(expert_id, instruction)``.  The supervisor is an
    ``ai:llm_agent`` that writes the chosen expert's id to its ``decision`` port;
    a ``flow:switch`` routes to that expert's node (default: straight to the end
    when no expert matches).
    """
    if not experts:
        raise ValueError("supervisor_topology requires at least one expert")
    expert_ids = [expert_id for expert_id, _ in experts]
    if len(set(expert_ids)) != len(expert_ids):
        raise ValueError("expert ids must be unique")
    if any(not expert_id or expert_id in (_START_ID, _END_ID, "supervisor", "dispatch") for expert_id in expert_ids):
        raise ValueError("expert ids must be non-empty and must not collide with reserved node ids")

    # ``data`` typed: the pick ports carry the truthy flag routed by flow:switch,
    # and the trailing ``out`` is the default (no-expert) edge's source port.
    switch_outputs = [_port(f"pick_{expert_id}") for expert_id in expert_ids] + [_port("out")]
    nodes = [
        _start(),
        Node(
            id="supervisor",
            type=NodeType.AI_LLM_AGENT,
            params={"instruction": supervisor_instruction},
            inputs=[_port("in")],
            outputs=[_port("out"), _port("decision")],
        ),
        Node(
            id="dispatch",
            type=NodeType.FLOW_SWITCH,
            params={"cases": [{"value": expert_id, "port": f"pick_{expert_id}"} for expert_id in expert_ids]},
            inputs=[_port("in")],
            outputs=switch_outputs,
        ),
        *[Node(id=expert_id, type=NodeType.AI_LLM_AGENT, params={"instruction": instruction}, inputs=[_port("in")], outputs=[_port("out")]) for expert_id, instruction in experts],
        _end(),
    ]
    edges = [
        Edge(source=_START_ID, source_port="input", target="supervisor", target_port="in"),
        Edge(source="supervisor", source_port="decision", target="dispatch", target_port="in"),
        # Default: no expert matched → end.
        Edge(source="dispatch", source_port="out", target=_END_ID, target_port="in"),
    ]
    for expert_id in expert_ids:
        edges.append(Edge(source="dispatch", source_port=f"pick_{expert_id}", target=expert_id, target_port="in", condition=f"pick_{expert_id}"))
        edges.append(Edge(source=expert_id, source_port="out", target=_END_ID, target_port="in"))
    return WorkflowDefinition(id=definition_id, name=name, nodes=nodes, edges=edges)


#: The named templates the canvas can offer.
TEMPLATES: dict[str, object] = {
    "critic_review_loop": critic_review_loop,
    "supervisor_topology": supervisor_topology,
}
