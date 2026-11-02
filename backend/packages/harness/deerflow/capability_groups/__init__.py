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
    capability_group_content_hash,
)
from deerflow.capability_groups.reveal import resolve_reveal_target, reveal_in_file_manager
from deerflow.capability_groups.runtime import (
    CapabilityContentError,
    CapabilityRule,
    CapabilitySkill,
    load_capability_rules,
    load_capability_skills,
)

__all__ = [
    "CAPABILITY_CATEGORIES",
    "CapabilityContentError",
    "CapabilityGroup",
    "CapabilityGroupError",
    "CapabilityGroupFile",
    "CapabilityRule",
    "CapabilitySkill",
    "build_capability_contents",
    "capability_group_content_hash",
    "category_sort_key",
    "classify_capability_file",
    "load_capability_rules",
    "load_capability_skills",
    "resolve_reveal_target",
    "reveal_in_file_manager",
    "summarize_markdown",
]
