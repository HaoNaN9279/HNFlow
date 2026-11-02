"""Unified dependency-graph aggregation and cycle detection for workflows.

Aggregates three reference classes into a single directed graph:

- workflow → workflow  (``nested:subworkflow`` template references),
- workflow → skill    (``capability_groups`` resolved to stable ``skill_id``),
- skill → skill       (``Skill.dependencies`` guid references).

Cycle detection runs an iterative white/gray/black DFS (explicit stack, no
recursion) over namespaced graph nodes ``("workflow", id)`` / ``("skill", guid)``
so a workflow id can never collide with a skill guid.  Everything here is a pure
function — zero IO and zero ``app.*`` dependency — so the save path (T11-2) and
the CLI (T11-3) can both reuse it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from deerflow.skills.catalog import SkillCatalog
from deerflow.skills.types import Skill
from deerflow.workflow.compiler import WorkflowCompileError, parse_subworkflow_spec
from deerflow.workflow.schema import NodeType, WorkflowDefinition, declared_capability_groups

# A graph node is namespaced by reference kind: workflow ids and skill guids
# live in disjoint namespaces so an id/guid string collision cannot connect them.
GraphNode = tuple[str, str]

# ── Reference collection ───────────────────────────────────────────────────────


def collect_subworkflow_refs(definition: WorkflowDefinition) -> list[str]:
    """Collect every template id referenced by *definition* (inline subgraphs recursed).

    Walks ``nested:subworkflow`` nodes: template specs contribute their
    ``template_id``; inline specs are re-parsed as :class:`WorkflowDefinition`
    and scanned recursively — an inline child may itself carry template
    references.  Malformed specs are skipped defensively (``WorkflowCompileError``
    or a failed ``model_validate``) because the save path already intercepts
    them upstream; the compile step surfaces the real error later.

    Returns a deduplicated, order-stable list of ``template_id`` strings.
    """

    def _walk(current: WorkflowDefinition) -> None:
        for node in current.nodes:
            if node.type != NodeType.NESTED_SUBWORKFLOW:
                continue
            try:
                spec = parse_subworkflow_spec(node)
            except WorkflowCompileError:
                continue
            if spec is None:
                continue
            if spec["type"] == "template":
                refs.append(spec["template_id"])
                continue
            try:
                child = WorkflowDefinition.model_validate(spec["definition"])
            except Exception:
                continue
            _walk(child)

    refs: list[str] = []
    _walk(definition)
    return list(dict.fromkeys(refs))


def collect_skill_refs(definition: WorkflowDefinition, catalog: SkillCatalog) -> list[str]:
    """Collect the stable capability-group ids (``skill_id``) a workflow depends on.

    Walks every node's ``capability_groups`` (skill names at authoring time),
    maps each name to its skill via the catalog, and emits that skill's
    ``skill_id``.  Skills without a ``skill_id`` (public/legacy) and unknown
    names are skipped (fail-open).  Results are deduplicated and order-stable.

    Unlike :func:`deerflow.workflow.schema.collect_resolved_groups`, this returns
    bare ``skill_id`` strings rather than ``guid@v<version>`` — cycle detection
    keys graph nodes on the stable group identity, not a versioned string.
    """
    name_to_skill = {s.name: s for s in catalog.skills}
    refs: list[str] = []
    for node in definition.nodes:
        for name in declared_capability_groups(node):
            skill = name_to_skill.get(name)
            if skill is None or skill.skill_id is None:
                continue
            refs.append(skill.skill_id)
    return list(dict.fromkeys(refs))


# ── Cycle detection ────────────────────────────────────────────────────────────


def _node_label(node: GraphNode) -> str:
    """Render a graph node as ``kind:value`` (e.g. ``workflow:wf-a``)."""
    kind, value = node
    return f"{kind}:{value}"


def find_dependency_cycles(definitions: Mapping[str, WorkflowDefinition], skills: Iterable[Skill]) -> list[str]:
    """Detect every simple dependency cycle across workflows and capability groups.

    Builds a directed graph over namespaced nodes (``("workflow", id)`` /
    ``("skill", guid)``) with three edge classes:

    - ``(workflow, W) → (workflow, T)`` for each ``template_id`` T that exists in *definitions*;
    - ``(workflow, W) → (skill, G)`` for each ``skill_id`` G referenced via ``capability_groups``;
    - ``(skill, G) → (skill, G')`` for each ``DependencySpec.guid`` G' that exists in the skill set.

    Skills without a ``skill_id`` are not graph nodes.  Cycle detection is an
    iterative white/gray/black DFS with an explicit stack (no recursion), so it
    stays safe on large graphs.  Start points are traversed workflows-first (by
    id) then skills (by guid), and neighbours are sorted, so the same graph
    always yields the same result.

    Returns one string per simple cycle, e.g.
    ``"workflow:wf-a → skill:guid-b → skill:guid-c → workflow:wf-a"``, where the
    path starts and ends on the same node.
    """
    skill_list = tuple(skills)
    catalog = SkillCatalog(skill_list)

    # ── Node set ─────────────────────────────────────────────────────
    skill_by_guid: dict[str, Skill] = {}
    for skill in skill_list:
        if skill.skill_id is not None:
            skill_by_guid.setdefault(skill.skill_id, skill)

    # ── Adjacency (neighbours deduplicated then sorted for determinism) ──
    adjacency: dict[GraphNode, list[GraphNode]] = {}

    def add_edge(src: GraphNode, dst: GraphNode) -> None:
        adjacency.setdefault(src, []).append(dst)

    for wf_id, definition in definitions.items():
        wf_node: GraphNode = ("workflow", wf_id)
        for template_id in collect_subworkflow_refs(definition):
            if template_id in definitions:
                add_edge(wf_node, ("workflow", template_id))
        for skill_id in collect_skill_refs(definition, catalog):
            if skill_id in skill_by_guid:
                add_edge(wf_node, ("skill", skill_id))

    for guid, skill in skill_by_guid.items():
        skill_node: GraphNode = ("skill", guid)
        for dep in skill.dependencies or ():
            if dep.guid in skill_by_guid:
                add_edge(skill_node, ("skill", dep.guid))

    for neighbors in adjacency.values():
        neighbors.sort()

    # ── Deterministic start order: workflows (by id), then skills (by guid) ──
    start_order: list[GraphNode] = [("workflow", wf_id) for wf_id in sorted(definitions)] + [("skill", guid) for guid in sorted(skill_by_guid)]

    # ── Iterative DFS (white/gray/black, explicit stack) ──
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[GraphNode, int] = {node: WHITE for node in start_order}
    cycles: list[str] = []

    for start in start_order:
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        path: list[GraphNode] = [start]
        stack: list[tuple[GraphNode, int]] = [(start, 0)]  # (node, next-neighbour index)
        while stack:
            node, idx = stack[-1]
            neighbors = adjacency.get(node, ())
            if idx < len(neighbors):
                stack[-1] = (node, idx + 1)
                nxt = neighbors[idx]
                nxt_color = color[nxt]
                if nxt_color == WHITE:
                    color[nxt] = GRAY
                    path.append(nxt)
                    stack.append((nxt, 0))
                elif nxt_color == GRAY:
                    # Back edge to a node still on the current path → a cycle.
                    start_idx = path.index(nxt)
                    cycle_nodes = [*path[start_idx:], nxt]
                    cycles.append(" → ".join(_node_label(n) for n in cycle_nodes))
                # BLACK → already fully explored, skip.
            else:
                color[node] = BLACK
                path.pop()
                stack.pop()

    return cycles
