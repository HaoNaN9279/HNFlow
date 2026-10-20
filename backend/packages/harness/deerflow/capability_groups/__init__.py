"""Capability groups: versioned, GUID-addressed capability packages.

A capability group owns its own resources; a skill is one resource inside a
group, never a group itself.
"""

from deerflow.capability_groups.contents import (
    CAPABILITY_CATEGORIES,
    CapabilityGroupFile,
    build_capability_contents,
    category_sort_key,
    classify_capability_file,
    summarize_markdown,
)
from deerflow.capability_groups.discovery import (
    CapabilityGroup,
    CapabilityGroupError,
    discover_capability_groups,
    load_capability_group,
)
from deerflow.capability_groups.reveal import resolve_reveal_target, reveal_in_file_manager

__all__ = [
    "CAPABILITY_CATEGORIES",
    "CapabilityGroup",
    "CapabilityGroupError",
    "CapabilityGroupFile",
    "build_capability_contents",
    "category_sort_key",
    "classify_capability_file",
    "discover_capability_groups",
    "load_capability_group",
    "resolve_reveal_target",
    "reveal_in_file_manager",
    "summarize_markdown",
]
