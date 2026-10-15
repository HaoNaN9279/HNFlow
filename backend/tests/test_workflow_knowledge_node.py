"""Tests for the ``data:knowledge`` node executor (N14 §24.2)."""

from __future__ import annotations

from typing import Any

import pytest

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors.knowledge import exec_knowledge
from deerflow.workflow.knowledge import KNOWLEDGE_STORE_CONTEXT_KEY, Chunk, InMemoryKnowledgeStore
from deerflow.workflow.registry import WorkflowExecutionError


def _runtime(store: Any) -> Any:
    return WorkflowRuntime(context={KNOWLEDGE_STORE_CONTEXT_KEY: store} if store is not None else {})


class TestRetrieve:
    @pytest.mark.asyncio
    async def test_retrieve_returns_records(self) -> None:
        store = InMemoryKnowledgeStore()
        await exec_knowledge(_runtime(store), {"operation": "ingest", "collection": "kb", "doc_id": "d1", "source": "policy.txt"}, {"in": "the refund policy is 30 days"})
        out = await exec_knowledge(_runtime(store), {"operation": "retrieve", "collection": "kb"}, {"in": "refund"})
        assert out["out"].startswith("cite:")
        assert len(out["records"]) == 1
        assert out["records"][0]["source"] == "policy.txt"
        assert "30 days" in out["records"][0]["text"]

    @pytest.mark.asyncio
    async def test_retrieve_query_template(self) -> None:
        store = InMemoryKnowledgeStore()
        store.upsert("kb", [Chunk("a#0", "a", "alpha beta", source="s", ordinal=0)])
        out = await exec_knowledge(_runtime(store), {"operation": "retrieve", "collection": "kb", "query": "{{topic}}"}, {"topic": "alpha"})
        assert len(out["records"]) == 1

    @pytest.mark.asyncio
    async def test_no_store_fails(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="no knowledge_store"):
            await exec_knowledge(_runtime(None), {"operation": "retrieve", "collection": "kb"}, {"in": "x"})

    @pytest.mark.asyncio
    async def test_missing_collection(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="collection"):
            await exec_knowledge(_runtime(InMemoryKnowledgeStore()), {"operation": "retrieve"}, {})

    @pytest.mark.asyncio
    async def test_unknown_operation(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="unknown operation"):
            await exec_knowledge(_runtime(InMemoryKnowledgeStore()), {"operation": "frobnicate", "collection": "kb"}, {})


class TestIngest:
    @pytest.mark.asyncio
    async def test_ingest_chunks_and_stores(self) -> None:
        store = InMemoryKnowledgeStore()
        out = await exec_knowledge(_runtime(store), {"operation": "ingest", "collection": "kb", "doc_id": "d1"}, {"in": "one two three"})
        assert out["out"] == 1
        assert out["records"][0]["citation"] == "cite:d1#0"
        assert store.collections() == ["kb"]

    @pytest.mark.asyncio
    async def test_ingest_requires_doc_id(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="doc_id"):
            await exec_knowledge(_runtime(InMemoryKnowledgeStore()), {"operation": "ingest", "collection": "kb"}, {"in": "text"})

    @pytest.mark.asyncio
    async def test_ingest_requires_document(self) -> None:
        with pytest.raises(WorkflowExecutionError, match="ingest requires a document"):
            await exec_knowledge(_runtime(InMemoryKnowledgeStore()), {"operation": "ingest", "collection": "kb", "doc_id": "d1"}, {})

    @pytest.mark.asyncio
    async def test_ingest_text_param(self) -> None:
        store = InMemoryKnowledgeStore()
        out = await exec_knowledge(_runtime(store), {"operation": "ingest", "collection": "kb", "doc_id": "d1", "text": "hello world"}, {})
        assert out["out"] == 1
