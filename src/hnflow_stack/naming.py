"""Qualified ids and host names for resolved content.

Ids stay stable across agents: ``<group>/<name>`` for group-root content and
``<group>/<alias>/<name>`` for module content. Host names mirror the DSH
adapter's ``capability-<group>-<alias>-<name>`` scheme so that Python and
JavaScript agree on every injected name.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

DEFAULT_PREFIX = "capability"
DEFAULT_MAX_NAME_LENGTH = 48
MAX_HOST_NAME_LENGTH = 64

_SLUG_SEPARATORS = re.compile(r"[^a-z0-9]+")
_VALID_MODULE_PATH = re.compile(
    r"^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$"
)


def slug(value: str) -> str:
    """Lowercase ASCII slug, matching the DSH adapter's ``slug``."""
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    collapsed = _SLUG_SEPARATORS.sub("-", ascii_only.lower())
    return collapsed.strip("-")


def short_hash(value: str, length: int = 6) -> str:
    """First *length* hex characters of the SHA-256 digest of *value*."""
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:length]


def canonical_name(
    prefix: str,
    group: str,
    module: str,
    name: str,
    max_length: int = DEFAULT_MAX_NAME_LENGTH,
) -> str:
    """Return the host-visible name for one group or module entry.

    Root content keeps the historical ``<prefix>-<group>-<name>`` shape; module
    content inserts one alias segment. Overlong names are truncated and given a
    short digest so that two long names cannot silently collide.
    """
    lead = slug(prefix) or DEFAULT_PREFIX
    parts = [lead, slug(group) or "group"]
    if module:
        parts.append(slug(module) or "module")
    parts.append(slug(name) or "unit")
    joined = "-".join(part for part in parts if part)
    if len(joined) <= max_length:
        return joined
    hash_input = f"{group}/{module + '/' if module else ''}{name}"
    suffix = short_hash(hash_input)
    head = joined[: max(1, max_length - len(suffix) - 1)].rstrip("-")
    return f"{head}-{suffix}"


def qualified_id(group: str, module: str, name: str) -> str:
    """Return the stable id of one rule, skill, agent, or command."""
    if module:
        return f"{group}/{module}/{name}"
    return f"{group}/{name}"


def content_key(module: str, name: str) -> str:
    """Return the plan dictionary key for an agent or command.

    Group-root content keeps its bare name so existing stacks resolve unchanged;
    module content is namespaced by alias so equal names never overwrite each
    other.
    """
    if module:
        return f"{module}/{name}"
    return name


def valid_module_path(value: str, max_depth: int = 3) -> bool:
    """Check a module path such as ``battle/ai``."""
    if not value or not _VALID_MODULE_PATH.match(value):
        return False
    return value.count("/") + 1 <= max_depth


def module_alias(path: str) -> str:
    """Default alias for a module path: every segment joined by ``-``."""
    return "-".join(segment for segment in path.split("/") if segment)


def join_paths(module: str, name: str) -> str:
    """Join a module path with a unit name for display keys."""
    return f"{module}/{name}" if module else name
