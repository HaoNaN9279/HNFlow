"""Capability groups: versioned, GUID-addressed capability packages.

A capability group owns its own resources; a skill is one resource inside a
group, never a group itself.
"""

from deerflow.capability_groups.contents import (
    CAPABILITY_CATEGORIES,
    CapabilityGroupFile,
    build_capability_contents,
    classify_capability_file,
    summarize_markdown,
)
from deerflow.capability_groups.discovery import (
    CapabilityGroup,
    CapabilityGroupError,
    discover_capability_groups,
    load_capability_group,
)
from deerflow.capability_groups.reveal import reveal_in_file_manager

__all__ = [
    "CAPABILITY_CATEGORIES",
    "CapabilityGroup",
    "CapabilityGroupError",
    "CapabilityGroupFile",
    "build_capability_contents",
    "classify_capability_file",
    "discover_capability_groups",
    "load_capability_group",
    "reveal_in_file_manager",
    "summarize_markdown",
]
