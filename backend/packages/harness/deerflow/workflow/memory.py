"""Node-level memory access for AI workflow nodes (N14 §24.1).

The lead agent has a memory system (DeerMem) behind middleware; a workflow
``ai:llm_agent`` node has none, so it cannot accumulate a fact across runs or
read what a previous node learned.  §24.1 defines four memory scopes — session /
node / workflow / long-term — and wants a node to declare what it reads and
writes.

This module is the pure policy + formatting layer:

- a node declares ``params.memory = {scopes, query?, inject_budget?, write?,
  write_scope?}``;
- the executor resolves a :class:`MemoryStore` from the run context
  (``memory_store``), searches the declared scopes, and prepends a budgeted
  ``<memory>`` block to the prompt;
- after a successful run it writes the node's output back when ``write`` is set.

The store is a tiny protocol so the concrete backend (DeerMem, a test double) is
injected — the harness never reaches into a specific storage implementation here.
Async store methods are supported (the executor awaits an awaitable result).
"""

from __future__ import annotations

import inspect
import json
import re
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from deerflow.workflow.context_policy import estimate_tokens

#: The four scopes from §24.1.
MEMORY_SCOPES: frozenset[str] = frozenset({"session", "node", "workflow", "long_term"})

#: Runtime-context key carrying the memory store adapter.
MEMORY_STORE_CONTEXT_KEY = "memory_store"

#: Prompt block the memory is injected as.  ``<memory>`` is a framework-authority
#: tag already covered by the input-sanitization denylist.
MEMORY_BLOCK_TAG = "memory"

_ALLOWED_KEYS = frozenset({"scopes", "query", "inject_budget", "write", "write_scope"})
_TEMPLATE_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


class MemoryPolicyError(ValueError):
    """Raised when ``params.memory`` is malformed."""


@dataclass
class MemoryRecord:
    """One memory item returned by a store."""

    scope: str
    text: str
    key: str | None = None
    score: float | None = None


@dataclass
class MemoryPolicy:
    scopes: tuple[str, ...] = ()
    query: str | None = None
    inject_budget: int | None = None
    write: bool = False
    write_scope: str = "node"


@runtime_checkable
class MemoryStore(Protocol):
    """Minimal memory backend a node reads/writes through."""

    def search(self, scope: str, query: str, *, limit: int) -> Any: ...

    def put(self, scope: str, text: str, *, key: str | None = None) -> Any: ...


class InMemoryMemoryStore:
    """Reference store (tests / simple local use).  Substring search, append put."""

    def __init__(self) -> None:
        self._data: dict[str, list[MemoryRecord]] = {}

    def put(self, scope: str, text: str, *, key: str | None = None) -> None:
        self._data.setdefault(scope, []).append(MemoryRecord(scope=scope, text=text, key=key))

    def search(self, scope: str, query: str, *, limit: int = 5) -> list[MemoryRecord]:
        lowered = (query or "").lower()
        hits = [r for r in self._data.get(scope, []) if lowered in r.text.lower()] if lowered else list(self._data.get(scope, []))
        return hits[:limit]


def parse_memory_policy(params: dict | None) -> MemoryPolicy | None:
    """Parse ``params.memory`` into a :class:`MemoryPolicy`, or ``None`` when absent."""
    raw = (params or {}).get("memory")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise MemoryPolicyError("params.memory must be an object")
    unknown = set(raw) - _ALLOWED_KEYS
    if unknown:
        raise MemoryPolicyError(f"params.memory has unknown keys {sorted(unknown)}; allowed: {sorted(_ALLOWED_KEYS)}")

    scopes_raw = raw.get("scopes", [])
    if not isinstance(scopes_raw, (list, tuple)) or not scopes_raw:
        raise MemoryPolicyError("params.memory.scopes must be a non-empty list")
    bad_scopes = [s for s in scopes_raw if not isinstance(s, str) or s not in MEMORY_SCOPES]
    if bad_scopes:
        raise MemoryPolicyError(f"params.memory.scopes has unknown scopes {bad_scopes}; allowed: {sorted(MEMORY_SCOPES)}")

    query = raw.get("query")
    if query is not None and not isinstance(query, str):
        raise MemoryPolicyError("params.memory.query must be a string")

    budget = raw.get("inject_budget")
    if budget is not None:
        if isinstance(budget, bool) or not isinstance(budget, int) or budget <= 0:
            raise MemoryPolicyError("params.memory.inject_budget must be a positive integer")

    write = raw.get("write", False)
    if not isinstance(write, bool):
        raise MemoryPolicyError("params.memory.write must be a boolean")

    write_scope = raw.get("write_scope", "node")
    if write_scope not in MEMORY_SCOPES:
        raise MemoryPolicyError(f"params.memory.write_scope must be one of {sorted(MEMORY_SCOPES)}, got {write_scope!r}")

    return MemoryPolicy(scopes=tuple(str(s) for s in scopes_raw), query=query, inject_budget=budget, write=write, write_scope=write_scope)


def render_query(template: str | None, inputs: dict[str, Any], *, default: str = "") -> str:
    """Render a ``{{port}}`` query template against *inputs* (missing → empty)."""
    if not template:
        return default
    return _TEMPLATE_RE.sub(lambda m: "" if inputs.get(m.group(1)) is None else str(inputs.get(m.group(1))), template)


def format_memory_block(records: list[MemoryRecord], *, budget: int | None = None) -> str:
    """Render records as a ``<memory>`` block, dropping items past *budget* tokens.

    Deterministic: records are kept in the order the store returned them;
    a record whose addition would exceed the budget stops the fill (the store's
    ranking is the priority order).  No records → empty string.
    """
    kept: list[str] = []
    used = 0
    for record in records:
        text = (record.text or "").strip()
        if not text:
            continue
        cost = estimate_tokens(text)
        if budget is not None and used + cost > budget:
            break
        kept.append(f"[{record.scope}] {text}")
        used += cost
    if not kept:
        return ""
    return f"<{MEMORY_BLOCK_TAG}>\n" + "\n".join(kept) + f"\n</{MEMORY_BLOCK_TAG}>"


def collect_memory(store: MemoryStore, policy: MemoryPolicy, *, query: str, limit: int = 5) -> list[MemoryRecord]:
    """Search every declared scope (sync store; async callers use ``acollect_memory``)."""
    records: list[MemoryRecord] = []
    for scope in policy.scopes:
        result = store.search(scope, query, limit=limit)
        if inspect.isawaitable(result):  # pragma: no cover — async store must use acollect_memory
            raise MemoryPolicyError("memory store returned an awaitable; use acollect_memory")
        records.extend(result or [])
    return records


async def acollect_memory(store: MemoryStore, policy: MemoryPolicy, *, query: str, limit: int = 5) -> list[MemoryRecord]:
    """Async variant: awaits a store whose ``search`` returns awaitables."""
    records: list[MemoryRecord] = []
    for scope in policy.scopes:
        result = store.search(scope, query, limit=limit)
        if inspect.isawaitable(result):
            result = await result
        records.extend(result or [])
    return records


async def awrite_memory(store: MemoryStore, *, scope: str, text: str, key: str | None = None) -> None:
    """Write one memory item, awaiting an async store."""
    result = store.put(scope, text, key=key)
    if inspect.isawaitable(result):
        await result


def output_text(output: dict[str, Any]) -> str:
    """Pick a stable text representation of a node's output for the write-back."""
    value = output.get("out")
    if isinstance(value, str):
        return value
    if value is None:
        return json.dumps(output, default=str, ensure_ascii=False)
    return json.dumps(value, default=str, ensure_ascii=False)
