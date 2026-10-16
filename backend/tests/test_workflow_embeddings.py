"""Tests for N14 §24.2 embedding-backed knowledge store (`deerflow.workflow.embeddings`)."""

from __future__ import annotations

import math

import pytest

from deerflow.workflow.embeddings import (
    EmbeddingError,
    VectorKnowledgeStore,
    cosine_similarity,
    embeddings_from_callable,
    embeddings_from_langchain,
    normalize_vector,
)
from deerflow.workflow.knowledge import Chunk, Document, InMemoryKnowledgeStore, KnowledgeStore, ingest_document


def _bag_embedder() -> object:
    """Deterministic toy embedder: bag-of-characters over a tiny vocabulary."""

    def embed(texts: list[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            lowered = text.lower()
            vectors.append(
                [
                    float(lowered.count("a")),
                    float(lowered.count("b")),
                    float(lowered.count("c")),
                    float(lowered.count("d")),
                ]
            )
        return vectors

    return embeddings_from_callable(embed)


def _chunk(chunk_id: str, text: str, *, source: str = "doc") -> Chunk:
    return Chunk(id=chunk_id, doc_id="doc-1", text=text, source=source, ordinal=0)


# ── pure vector helpers ───────────────────────────────────────────────────────


class TestVectorHelpers:
    def test_normalize_scales_to_unit_length(self) -> None:
        vector = normalize_vector([3.0, 4.0])
        assert math.isclose(sum(component * component for component in vector), 1.0, rel_tol=1e-9)

    def test_normalize_zero_vector_is_unchanged(self) -> None:
        assert normalize_vector([0.0, 0.0]) == [0.0, 0.0]

    def test_cosine_identical_vectors_is_one(self) -> None:
        assert cosine_similarity([1.0, 2.0], [1.0, 2.0]) == 1.0

    def test_cosine_orthogonal_is_zero(self) -> None:
        assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == 0.0

    def test_cosine_opposite_is_minus_one(self) -> None:
        assert cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == -1.0

    def test_cosine_zero_vector_is_zero(self) -> None:
        assert cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0

    def test_cosine_dimension_mismatch_raises(self) -> None:
        with pytest.raises(EmbeddingError):
            cosine_similarity([1.0], [1.0, 2.0])

    def test_cosine_empty_vectors_raise(self) -> None:
        with pytest.raises(EmbeddingError):
            cosine_similarity([], [])


# ── adapters ──────────────────────────────────────────────────────────────────


class TestAdapters:
    def test_callable_adapter_embeds(self) -> None:
        embedder = embeddings_from_callable(lambda texts: [[float(len(t))] for t in texts])
        assert embedder.embed(["ab", "abcd"]) == [[2.0], [4.0]]

    def test_callable_adapter_rejects_non_callable(self) -> None:
        with pytest.raises(EmbeddingError):
            embeddings_from_callable("not-a-function")

    def test_langchain_adapter_uses_embed_documents(self) -> None:
        class _Embeddings:
            def embed_documents(self, texts: list[str]) -> list[list[float]]:
                return [[float(len(text))] for text in texts]

        assert embeddings_from_langchain(_Embeddings()).embed(["ab"]) == [[2.0]]

    def test_langchain_adapter_rejects_a_foreign_object(self) -> None:
        with pytest.raises(EmbeddingError):
            embeddings_from_langchain(object()).embed(["ab"])

    def test_store_satisfies_the_knowledge_store_protocol(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        assert isinstance(store, KnowledgeStore)
        assert isinstance(InMemoryKnowledgeStore(), KnowledgeStore)


# ── store: writes ─────────────────────────────────────────────────────────────


class TestVectorStoreUpsert:
    def test_upsert_embeds_and_stores(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        assert store.upsert("c", [_chunk("a", "abc")]) == 1
        assert store.size("c") == 1
        assert store.collections() == ["c"]

    def test_upsert_empty_list_is_a_noop(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        assert store.upsert("c", []) == 0
        assert store.collections() == []

    def test_upsert_is_idempotent_by_chunk_id(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaa")])
        store.upsert("c", [_chunk("a", "bbb")])
        assert store.size("c") == 1
        [record] = store.query("c", "bbb", top_k=5)
        assert record.text == "bbb"

    def test_upsert_uses_a_precomputed_embedding_without_calling_the_embedder(self) -> None:
        calls: list[list[str]] = []

        def embed(texts: list[str]) -> list[list[float]]:
            calls.append(list(texts))
            return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

        store = VectorKnowledgeStore(embeddings_from_callable(embed))
        precomputed = Chunk(id="a", doc_id="d", text="abc", embedding=[0.0, 1.0, 0.0, 0.0])
        store.upsert("c", [precomputed])
        assert calls == []
        # The caller's chunk object is left untouched.
        assert precomputed.embedding == [0.0, 1.0, 0.0, 0.0]

    def test_upsert_does_not_mutate_the_caller_chunk_without_embedding(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        chunk = _chunk("a", "abc")
        store.upsert("c", [chunk])
        assert chunk.embedding is None

    def test_embedder_returning_the_wrong_count_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[1.0]]))
        with pytest.raises(EmbeddingError):
            store.upsert("c", [_chunk("a", "abc"), _chunk("b", "def")])

    def test_embedder_returning_nothing_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: None))
        with pytest.raises(EmbeddingError):
            store.upsert("c", [_chunk("a", "abc")])

    def test_embedder_returning_non_numeric_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [["nope"]]))
        with pytest.raises(EmbeddingError):
            store.upsert("c", [_chunk("a", "abc")])

    def test_embedder_returning_ragged_vectors_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[1.0], [1.0, 2.0]]))
        with pytest.raises(EmbeddingError):
            store.upsert("c", [_chunk("a", "ab"), _chunk("b", "cd")])

    def test_embedder_returning_zero_width_vectors_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[]]))
        with pytest.raises(EmbeddingError):
            store.upsert("c", [_chunk("a", "ab")])

    def test_precomputed_empty_embedding_raises(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        with pytest.raises(EmbeddingError):
            store.upsert("c", [Chunk(id="a", doc_id="d", text="ab", embedding=[])])


# ── store: reads ──────────────────────────────────────────────────────────────


class TestVectorStoreQuery:
    def test_ranks_the_closest_chunk_first(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "bbbb"), _chunk("c", "cccc")])
        records = store.query("c", "aaaa", top_k=3)
        assert [record.chunk_id for record in records] == ["a"]
        assert records[0].score == 1.0

    def test_top_k_limits_results(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "bbbb")])
        assert len(store.query("c", "aaaa", top_k=1)) == 1

    def test_top_k_zero_returns_empty(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa")])
        assert store.query("c", "aaaa", top_k=0) == []

    def test_unknown_collection_returns_empty(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        assert store.query("missing", "aaaa") == []

    def test_non_positive_scores_are_dropped_for_a_real_query(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "bbbb")])
        records = store.query("c", "aaaa", top_k=5)
        assert [record.chunk_id for record in records] == ["a"]

    def test_empty_query_keeps_every_score_and_stays_deterministic(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("b", "bbbb"), _chunk("a", "aaaa")])
        records = store.query("c", "   ", top_k=5)
        assert [record.chunk_id for record in records] == ["a", "b"]

    def test_ties_break_on_citation_so_order_is_stable(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("b", "aaaa"), _chunk("a", "aaaa")])
        records = store.query("c", "aaaa", top_k=5)
        assert [record.chunk_id for record in records] == ["a", "b"]

    def test_citations_use_the_shared_prefix(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa")])
        assert store.query("c", "aaaa")[0].citation == "cite:a"

    def test_reranker_reorders_and_is_bounded_by_top_k(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "bbbb")])
        # "ab" scores equally against both, so citation order gives ["a", "b"].
        assert [record.chunk_id for record in store.query("c", "ab", top_k=2)] == ["a", "b"]

        def reranker(_query: str, records: list) -> list:
            return list(reversed(records))

        assert store.query("c", "ab", top_k=1, reranker=reranker)[0].chunk_id == "b"

    def test_a_failing_reranker_leaves_the_ranking_intact(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "bbbb")])

        def boom(_query: str, _records: list) -> list:
            raise RuntimeError("reranker down")

        assert store.query("c", "aaaa", top_k=2, reranker=boom)[0].chunk_id == "a"

    def test_dimension_mismatch_between_stored_and_query_vectors_raises(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[1.0, 0.0] for _ in texts]))
        store.upsert("c", [_chunk("a", "ab")])
        # A second, differently-shaped embedder on the same store simulates a
        # model swap under a populated index.
        swapped = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[1.0, 0.0, 0.0] for _ in texts]))
        swapped._data = store._data
        with pytest.raises(EmbeddingError):
            swapped.query("c", "aaaa")

    def test_normalization_off_still_ranks_by_cosine(self) -> None:
        store = VectorKnowledgeStore(embeddings_from_callable(lambda texts: [[float(len(t)), 1.0] for t in texts]), normalize=False)
        store.upsert("c", [_chunk("a", "aaaa"), _chunk("b", "b")])
        assert store.query("c", "aaaa")[0].chunk_id == "a"


# ── integration with the shared ingestion/query helpers ───────────────────────


class TestIngestionIntegration:
    def test_ingest_document_then_query_round_trip(self) -> None:
        store = VectorKnowledgeStore(_bag_embedder())
        chunks = ingest_document(store, collection="kb", document=Document(id="d1", text="a" * 120, source="s1"))
        assert chunks
        assert store.size("kb") == len(chunks)
        records = store.query("kb", "aaaa", top_k=2)
        assert records
        assert records[0].citation.startswith("cite:d1#")

    def test_interchangeable_with_the_in_memory_store(self) -> None:
        document = Document(id="d1", text="alpha beta gamma", source="s1")
        keyword = InMemoryKnowledgeStore()
        vector = VectorKnowledgeStore(_bag_embedder())
        for store in (keyword, vector):
            ingest_document(store, collection="kb", document=document)
            assert store.query("kb", "alpha", top_k=5)
