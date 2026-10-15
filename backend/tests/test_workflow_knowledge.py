"""Tests for N14 §24.2 knowledge retrieval (:mod:`deerflow.workflow.knowledge`)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from deerflow.workflow.knowledge import (
    KNOWLEDGE_STORE_CONTEXT_KEY,
    Chunk,
    Document,
    InMemoryKnowledgeStore,
    KnowledgeError,
    RetrievalPolicy,
    RetrievalRecord,
    aquery,
    chunk_text,
    format_retrieval_block,
    ingest_document,
    parse_retrieval_params,
    rank_chunks,
    render_query,
    tokenize,
)


class TestChunkText:
    def test_empty(self) -> None:
        assert chunk_text("") == []
        assert chunk_text("   ") == []

    def test_short_is_one_chunk(self) -> None:
        assert chunk_text("hello world", size=100, overlap=0) == ["hello world"]

    def test_long_windows_with_overlap(self) -> None:
        text = "abcdefghij"  # 10 chars
        chunks = chunk_text(text, size=4, overlap=2)
        assert chunks == ["abcd", "cdef", "efgh", "ghij"]
        # Overlap means consecutive windows share 2 chars.
        assert chunks[0][-2:] == chunks[1][:2]

    def test_custom_overlap_zero(self) -> None:
        assert chunk_text("abcdef", size=3, overlap=0) == ["abc", "def"]

    @pytest.mark.parametrize("size,overlap", [(0, 0), (-1, 0), (5, 5), (5, 6), (5, -1)])
    def test_bad_config(self, size: int, overlap: int) -> None:
        with pytest.raises(KnowledgeError):
            chunk_text("abc", size=size, overlap=overlap)


class TestTokenize:
    def test_ascii(self) -> None:
        assert tokenize("Hello World 123") == ["hello", "world", "123"]

    def test_cjk_per_char(self) -> None:
        assert tokenize("知识检索") == ["知", "识", "检", "索"]


class TestRankChunks:
    def _chunks(self) -> list[Chunk]:
        return [
            Chunk("a#0", "a", "the cat sat on the mat", source="a.txt", ordinal=0),
            Chunk("b#0", "b", "dogs are loyal", source="b.txt", ordinal=0),
            Chunk("c#0", "c", "cat and dog", source="c.txt", ordinal=0),
        ]

    def test_scores_and_order(self) -> None:
        records = rank_chunks(self._chunks(), "cat dog")
        assert records[0].chunk_id == "c#0"  # matches both terms
        assert all(r.score > 0 for r in records)
        assert records[0].citation == "cite:c#0"

    def test_top_k(self) -> None:
        assert len(rank_chunks(self._chunks(), "cat", top_k=1)) == 1

    def test_empty_query_preserves_order(self) -> None:
        records = rank_chunks(self._chunks(), "")
        assert [r.chunk_id for r in records] == ["a#0", "b#0", "c#0"]

    def test_no_match_returns_empty(self) -> None:
        assert rank_chunks(self._chunks(), "zebra") == []

    def test_top_k_non_positive(self) -> None:
        assert rank_chunks(self._chunks(), "cat", top_k=0) == []

    def test_reranker_applied(self) -> None:
        ordered = rank_chunks(self._chunks(), "cat", reranker=lambda _q, recs: list(reversed(recs)))
        assert ordered[0].chunk_id == "a#0"

    def test_reranker_failure_ignored(self) -> None:
        def _boom(_q: str, _r: list[RetrievalRecord]) -> list[RetrievalRecord]:
            raise RuntimeError("rerank down")

        assert rank_chunks(self._chunks(), "cat", reranker=_boom)


class TestInMemoryStore:
    def test_upsert_query(self) -> None:
        store = InMemoryKnowledgeStore()
        store.upsert("kb", [Chunk("a#0", "a", "alpha beta", ordinal=0)])
        assert store.query("kb", "alpha")[0].text == "alpha beta"

    def test_collection_isolation(self) -> None:
        store = InMemoryKnowledgeStore()
        store.upsert("kb", [Chunk("a#0", "a", "x", ordinal=0)])
        assert store.query("other", "x") == []
        assert store.collections() == ["kb"]

    def test_ingest_document(self) -> None:
        store = InMemoryKnowledgeStore()
        chunks = ingest_document(store, collection="kb", document=Document(id="doc", text="one two three", source="d.txt"))
        assert [c.id for c in chunks] == ["doc#0"]
        assert chunks[0].source == "d.txt"
        assert store.query("kb", "two")[0].doc_id == "doc"


class TestParseRetrievalParams:
    def test_absent(self) -> None:
        assert parse_retrieval_params({}) is None

    def test_full(self) -> None:
        policy = parse_retrieval_params({"retrieval": {"collection": "kb", "query": "{{in}}", "top_k": 3, "ctx_budget": 100, "rerank": True}})
        assert policy == RetrievalPolicy(collection="kb", query="{{in}}", top_k=3, ctx_budget=100, rerank=True)

    @pytest.mark.parametrize(
        "bad",
        [
            "x",
            {},
            {"collection": ""},
            {"collection": "kb", "nope": 1},
            {"collection": "kb", "query": 5},
            {"collection": "kb", "top_k": 0},
            {"collection": "kb", "top_k": 99},
            {"collection": "kb", "top_k": True},
            {"collection": "kb", "ctx_budget": 0},
            {"collection": "kb", "rerank": "yes"},
        ],
    )
    def test_bad(self, bad: Any) -> None:
        with pytest.raises(KnowledgeError):
            parse_retrieval_params({"retrieval": bad})


class TestRenderAndFormat:
    def test_render_query(self) -> None:
        assert render_query("find {{topic}}", {"topic": "cats"}) == "find cats"
        assert render_query("x {{m}}", {}, default="dflt") == "x "
        assert render_query(None, {}, default="dflt") == "dflt"

    def test_format_empty(self) -> None:
        assert format_retrieval_block([]) == ""

    def test_format_renders_citation(self) -> None:
        block = format_retrieval_block([RetrievalRecord("a#0", "a", "hello", source="a.txt", citation="cite:a#0")])
        assert block.startswith("<context>")
        assert "cite:a#0 a.txt" in block
        assert "hello" in block

    def test_format_budget_drops(self) -> None:
        from deerflow.workflow.context_policy import estimate_tokens

        records = [RetrievalRecord("a#0", "a", "x" * 50, citation="cite:a#0"), RetrievalRecord("b#0", "b", "y" * 50, citation="cite:b#0")]
        one_cost = estimate_tokens("--- cite:a#0 a ---") + estimate_tokens("x" * 50)
        block = format_retrieval_block(records, budget=one_cost)
        assert "xxxxx" in block
        assert "yyyyy" not in block


class TestAQuery:
    @pytest.mark.asyncio
    async def test_async_store(self) -> None:
        class AsyncStore:
            async def upsert(self, collection: str, chunks: list[Chunk]) -> None:
                pass

            async def query(self, collection: str, query: str, *, top_k: int = 5, reranker: Any = None) -> list[RetrievalRecord]:
                return [RetrievalRecord("a#0", "a", "hit")]

        records = await aquery(AsyncStore(), RetrievalPolicy(collection="kb"), query="x")
        assert records[0].text == "hit"


# ── executor integration ─────────────────────────────────────────────────────


@dataclass
class _Status:
    value: str = "completed"


class _Result:
    status = _Status()
    result = "ok"
    token_usage_records: list[Any] | None = None
    stop_reason: str | None = None


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> Any:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            captured["task"] = task
            return _Result()

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *a, **k: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda *a, **k: None)
    yield captured


def _runtime(store: Any) -> Any:
    from deerflow.workflow.compiler import WorkflowRuntime

    return WorkflowRuntime(context={"user_id": "u1", "thread_id": "t", KNOWLEDGE_STORE_CONTEXT_KEY: store})


class TestExecutorRetrieval:
    @pytest.mark.asyncio
    async def test_retrieves_and_injects(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        store = InMemoryKnowledgeStore()
        store.upsert("kb", [Chunk("a#0", "a", "the refund policy is 30 days", source="policy.txt", ordinal=0)])
        await exec_llm_agent(_runtime(store), {"instruction": "hi", "node_id": "n", "retrieval": {"collection": "kb", "query": "refund"}}, {})
        assert "<context>" in fake_executor["task"]
        assert "cite:a#0" in fake_executor["task"]
        assert "30 days" in fake_executor["task"]

    @pytest.mark.asyncio
    async def test_no_store_no_injection(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent

        await exec_llm_agent(_runtime(None), {"instruction": "hi", "node_id": "n", "retrieval": {"collection": "kb"}}, {})
        assert "<context>" not in fake_executor["task"]

    @pytest.mark.asyncio
    async def test_continue_rejects_retrieval(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        with pytest.raises(WorkflowExecutionError, match="retrieval is not supported"):
            await exec_llm_agent(_runtime(InMemoryKnowledgeStore()), {"instruction": "hi", "node_id": "n", "retrieval": {"collection": "kb"}}, {"continue_prompt": "more"})

    @pytest.mark.asyncio
    async def test_bad_retrieval_fails(self, fake_executor: dict[str, Any]) -> None:
        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        with pytest.raises(WorkflowExecutionError, match="invalid retrieval"):
            await exec_llm_agent(_runtime(InMemoryKnowledgeStore()), {"instruction": "hi", "node_id": "n", "retrieval": {"collection": ""}}, {})
