"""DeerMem-backed node memory store (N14 §24.1).

``workflow/memory.py`` defines the four-scope ``MemoryStore`` protocol an
``ai:llm_agent`` node reads/writes through; this module is the concrete adapter
over the existing DeerMem ``MemoryManager``.

Honest scope mapping: DeerMem is a **long-term user/agent** memory (summaries +
facts), so this adapter serves the ``long_term`` scope only.  The ``session`` /
``node`` / ``workflow`` scopes are not DeerMem's model — a store that wants them
implements the protocol directly; this adapter returns nothing for them rather
than pretending a long-term fact is session memory.  ``put`` routes through the
manager's normal extraction pipeline (``add_nowait``), not a raw fact append, so
the same scope/durability gates that govern conversation memory apply.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.memory import MemoryRecord

#: The only scope DeerMem can serve (user/agent long-term memory).
LONG_TERM_SCOPE = "long_term"

#: Fallback thread id for a write when the caller supplied none.
_DEFAULT_THREAD_ID = "workflow-memory"


class MemoryManagerStore:
    """A :class:`~deerflow.workflow.memory.MemoryStore` over a ``MemoryManager``.

    Usage::

        store = MemoryManagerStore(get_memory_manager(), user_id=..., agent_name=..., thread_id=...)
        runtime.context["memory_store"] = store

    ``search`` returns the manager's ranked facts as :class:`MemoryRecord`s (only
    when the backend declares ``supports_search``); ``put`` queues the text for
    the manager's normal extraction.  Both are no-ops for a non-``long_term``
    scope, and a backend that cannot search degrades to no recall rather than
    raising into the node.
    """

    def __init__(self, manager: Any, *, user_id: str | None = None, agent_name: str | None = None, thread_id: str | None = None) -> None:
        self._manager = manager
        self._user_id = user_id
        self._agent_name = agent_name
        self._thread_id = thread_id

    @property
    def manager(self) -> Any:
        return self._manager

    @property
    def supports_search(self) -> bool:
        return bool(getattr(self._manager, "supports_search", False))

    @staticmethod
    def _fact_text(fact: Any) -> str:
        if isinstance(fact, dict):
            for key in ("fact", "content", "text", "summary"):
                value = fact.get(key)
                if isinstance(value, str) and value.strip():
                    return value
            return str(fact)
        return str(fact)

    @staticmethod
    def _fact_key(fact: Any) -> str | None:
        if isinstance(fact, dict):
            key = fact.get("id") or fact.get("fact_id")
            if key is not None:
                return str(key)
        return None

    def search(self, scope: str, query: str, *, limit: int = 5) -> list[MemoryRecord]:
        """Return long-term facts matching *query* (empty for other scopes)."""
        if scope != LONG_TERM_SCOPE or not self.supports_search:
            return []
        try:
            facts = self._manager.search(query, top_k=limit, user_id=self._user_id, agent_name=self._agent_name)
        except NotImplementedError:
            return []
        return [MemoryRecord(scope=LONG_TERM_SCOPE, text=self._fact_text(fact), key=self._fact_key(fact)) for fact in facts or []]

    def put(self, scope: str, text: str, *, key: str | None = None) -> None:
        """Queue *text* for the manager's memory extraction (only ``long_term``)."""
        if scope != LONG_TERM_SCOPE or not text:
            return
        from langchain_core.messages import HumanMessage

        self._manager.add_nowait(self._thread_id or _DEFAULT_THREAD_ID, [HumanMessage(content=text)], agent_name=self._agent_name, user_id=self._user_id)
