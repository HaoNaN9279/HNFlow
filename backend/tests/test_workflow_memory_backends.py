"""Tests for the DeerMem ``MemoryManagerStore`` adapter (N14 §24.1)."""

from __future__ import annotations

from typing import Any

from deerflow.workflow.memory import MemoryRecord
from deerflow.workflow.memory_backends import MemoryManagerStore


class FakeManager:
    def __init__(self, *, supports_search: bool = True, facts: list[Any] | None = None, raises: bool = False) -> None:
        self.supports_search = supports_search
        self._facts = facts or []
        self._raises = raises
        self.search_args: dict[str, Any] = {}
        self.added: list[Any] = []

    def search(self, query: str, top_k: int = 5, *, user_id: str | None = None, agent_name: str | None = None) -> list[Any]:
        self.search_args = {"query": query, "top_k": top_k, "user_id": user_id, "agent_name": agent_name}
        if self._raises:
            raise NotImplementedError("no search")
        return self._facts[:top_k]

    def add_nowait(self, thread_id: str, messages: list[Any], *, agent_name: str | None = None, user_id: str | None = None) -> None:
        self.added.append({"thread_id": thread_id, "messages": messages, "agent_name": agent_name, "user_id": user_id})


class TestSearch:
    def test_maps_facts(self) -> None:
        store = MemoryManagerStore(FakeManager(facts=[{"id": "f1", "fact": "likes tea"}, {"id": "f2", "content": "prefers dark mode"}]), user_id="u", agent_name="a")
        records = store.search("long_term", "tea", limit=5)
        assert records == [MemoryRecord("long_term", "likes tea", key="f1"), MemoryRecord("long_term", "prefers dark mode", key="f2")]

    def test_passes_bucket_and_top_k(self) -> None:
        manager = FakeManager(facts=[{"fact": "x"}])
        store = MemoryManagerStore(manager, user_id="u", agent_name="a")
        store.search("long_term", "q", limit=3)
        assert manager.search_args == {"query": "q", "top_k": 3, "user_id": "u", "agent_name": "a"}

    def test_other_scope_is_empty(self) -> None:
        assert MemoryManagerStore(FakeManager(facts=[{"fact": "x"}])).search("node", "q") == []

    def test_unsupported_search_is_empty(self) -> None:
        assert MemoryManagerStore(FakeManager(supports_search=False, facts=[{"fact": "x"}])).search("long_term", "q") == []

    def test_not_implemented_is_empty(self) -> None:
        assert MemoryManagerStore(FakeManager(raises=True)).search("long_term", "q") == []

    def test_fact_text_fallbacks(self) -> None:
        store = MemoryManagerStore(FakeManager(facts=[{"text": "t"}, "plain string", {"other": 1}]))
        texts = [r.text for r in store.search("long_term", "q")]
        assert texts[0] == "t"
        assert texts[1] == "plain string"
        assert "other" in texts[2]


class TestPut:
    def test_queues_human_message(self) -> None:
        manager = FakeManager()
        store = MemoryManagerStore(manager, user_id="u", agent_name="a", thread_id="t1")
        store.put("long_term", "remember this")
        assert len(manager.added) == 1
        entry = manager.added[0]
        assert entry["thread_id"] == "t1"
        assert entry["user_id"] == "u" and entry["agent_name"] == "a"
        assert entry["messages"][0].content == "remember this"

    def test_default_thread_id(self) -> None:
        manager = FakeManager()
        MemoryManagerStore(manager).put("long_term", "x")
        assert manager.added[0]["thread_id"] == "workflow-memory"

    def test_other_scope_noop(self) -> None:
        manager = FakeManager()
        MemoryManagerStore(manager).put("session", "x")
        assert manager.added == []

    def test_empty_text_noop(self) -> None:
        manager = FakeManager()
        MemoryManagerStore(manager).put("long_term", "")
        assert manager.added == []


class TestSupportsSearch:
    def test_true(self) -> None:
        assert MemoryManagerStore(FakeManager(supports_search=True)).supports_search is True

    def test_false(self) -> None:
        assert MemoryManagerStore(FakeManager(supports_search=False)).supports_search is False
