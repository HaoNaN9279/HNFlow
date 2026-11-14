"""Qualified ids and host names for resolved content.

Ids stay stable across agents: ``<group>/<name>``. Host names mirror the DSH
adapter's ``capability-<group>-<name>`` scheme so that Python and JavaScript
agree on every injected name.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

DEFAULT_PREFIX = "capability"
DEFAULT_MAX_NAME_LENGTH = 48
MAX_HOST_NAME_LENGTH = 64

_SLUG_SEPARATORS = re.compile(r"[^a-z0-9]+")


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
    name: str,
    max_length: int = DEFAULT_MAX_NAME_LENGTH,
) -> str:
    """Return the host-visible name for one capability-group entry.

    The shape is ``<prefix>-<group>-<name>``. Overlong names are truncated and
    given a short digest so that two long names cannot silently collide.
    """
    lead = slug(prefix) or DEFAULT_PREFIX
    parts = [lead, slug(group) or "group", slug(name) or "unit"]
    joined = "-".join(part for part in parts if part)
    if len(joined) <= max_length:
        return joined
    suffix = short_hash(f"{group}/{name}")
    head = joined[: max(1, max_length - len(suffix) - 1)].rstrip("-")
    return f"{head}-{suffix}"


def qualified_id(group: str, name: str) -> str:
    """Return the stable id of one rule, skill, agent, or command."""
    return f"{group}/{name}"
