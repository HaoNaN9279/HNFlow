"""Project capability-group activation derived from workflow definitions.

The project stack is an additive projection of the groups workflows actually
select.  Activating a group never removes an unrelated entry: HNFlow only
inserts or updates the groups that the changed workflow needs.
"""

from __future__ import annotations

from pathlib import Path

from deerflow.capability_groups.vibestack import (
    ActivationResult,
    VibeStackError,
    VibeStackGroupRef,
    active_versions,
    ensure_project_stack,
    find_group,
    read_project_stack,
    upsert_project_groups,
)
from deerflow.workflow.capability_group_nodes import collect_effective_groups
from deerflow.workflow.schema import WorkflowDefinition


def collect_definition_group_refs(definition: WorkflowDefinition) -> list[str]:
    """Return every effective capability-group reference declared by AI nodes.

    A node's own ``capability_groups`` list is authoritative unless an
    ``ai:capability_group`` selector feeds its ``capability_groups`` port.
    Groups declared on an unconnected selector node are authoring leftovers and
    therefore do not activate the project.
    """
    return collect_effective_groups(definition)


def resolve_definition_groups(
    repository: Path,
    definition: WorkflowDefinition,
    *,
    active: dict[str, str] | None = None,
) -> list[VibeStackGroupRef]:
    """Resolve the definition's references to concrete name/version pairs."""
    resolved: dict[str, VibeStackGroupRef] = {}
    for reference in collect_definition_group_refs(definition):
        group = find_group(repository, reference, active=active)
        ref = VibeStackGroupRef(name=group.name, version=group.version)
        existing = resolved.get(ref.name)
        if existing is not None and existing.version != ref.version:
            raise VibeStackError(f"workflow selects capability group {ref.name!r} at both {existing.version!r} and {ref.version!r}; a project can activate only one version per group")
        resolved[ref.name] = ref
    return list(resolved.values())


def activate_definition_groups(
    project_root: Path,
    repository: Path,
    definition: WorkflowDefinition,
    *,
    core: VibeStackGroupRef | None = None,
) -> ActivationResult:
    """Add/update the definition's groups without touching unrelated entries."""
    stack = read_project_stack(project_root)
    active = active_versions(stack)
    groups = resolve_definition_groups(repository, definition, active=active)
    if not groups:
        ensured, created = ensure_project_stack(project_root, core=core)
        return ActivationResult(stack=ensured, changed=created, created=created)
    return upsert_project_groups(project_root, groups, core=core)


__all__ = [
    "activate_definition_groups",
    "collect_definition_group_refs",
    "resolve_definition_groups",
]
