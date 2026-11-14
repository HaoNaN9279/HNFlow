"""Exceptions for HNFlow."""

from __future__ import annotations


class HNFlowError(Exception):
    """Base error for every HNFlow failure."""


class GroupNotFoundError(HNFlowError):
    """A capability group or version does not exist."""


class GroupAlreadyActiveError(HNFlowError):
    """A capability group is already active in the project."""


class GroupNotActiveError(HNFlowError):
    """A capability group is not active in the project."""


class ToolNotFoundError(HNFlowError):
    """A tool package does not exist."""


class ProjectConfigError(HNFlowError):
    """``.hnflow/stack.json`` is missing or malformed."""


class PluginNotFoundError(HNFlowError):
    """No plugin adapter exists for the requested agent tool."""
