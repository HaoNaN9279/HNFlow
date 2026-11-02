"""Skill tool metadata tagging — marks tools that originate from a skill.

Mirrors ``mcp_metadata.py``: tools exposed by a skill are tagged with the
skill's name so that downstream layers can namespace-prefix them and avoid
cross-skill collisions (T8 capability-group namespace).
"""

from __future__ import annotations

from langchain_core.tools import BaseTool

SKILL_TOOL_METADATA_KEY = "deerflow_skill"
SKILL_TOOL_PREFIX_SEPARATOR = "_"


def tag_skill_tool(tool: BaseTool, skill_name: str) -> BaseTool:
    """Tag ``tool`` as originating from ``skill_name`` (in place, returns tool)."""
    tool.metadata = {**(tool.metadata or {}), SKILL_TOOL_METADATA_KEY: skill_name}
    return tool


def is_skill_tool(tool: BaseTool) -> bool:
    return isinstance((getattr(tool, "metadata", None) or {}).get(SKILL_TOOL_METADATA_KEY), str)


def get_skill_name(tool: BaseTool) -> str | None:
    value = (getattr(tool, "metadata", None) or {}).get(SKILL_TOOL_METADATA_KEY)
    return value if isinstance(value, str) else None


def prefixed_skill_tool_name(skill_name: str, tool_name: str) -> str:
    return f"{skill_name}{SKILL_TOOL_PREFIX_SEPARATOR}{tool_name}"


def strip_skill_tool_prefix(tool_name: str, skill_name: str) -> str:
    prefix = f"{skill_name}{SKILL_TOOL_PREFIX_SEPARATOR}"
    return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name
