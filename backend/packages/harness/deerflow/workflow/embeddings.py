"""Embedding-backed knowledge store (N14 §24.2 — pluggable vector backend).

N14k shipped the retrieval core with a deterministic keyword ranker and an
*in-process* reference store, and documented that "embedding/向量后端为可插拔
store".  This module is that plug: a :class:`VectorKnowledgeStore` that
implements the same :class:`~deerflow.workflow.knowledge.KnowledgeStore`
protocol as ``InMemoryKnowledgeStore`` but ranks by **cosine similarity** over
embeddings produced by an **injected** embedder.

Design decisions:

* **No new dependency.** The embedder is injected as a callable/protocol, so a
  deployment wires in whatever it already uses; :func:`embeddings_from_langchain`
  adapts any object exposing ``embed_documents`` (LangChain ``Embeddings``),
  which is what ``deerflow.models``-adjacent code already has.
* **Deterministic ordering.** Ties break on ``citation`` exactly like
  ``rank_chunks``, so a re-query cannot reshuffle equal-scoring chunks.
* **Fail loud, not silent-empty.** A malformed embedder answer (wrong count,
  ragged or non-numeric vectors, mismatched dimensions) raises
  :class:`EmbeddingError`.  Silently returning ``[]`` would look like "no
  match", which is the one outcome a retrieval bug must not be able to fake.
* **Upsert is idempotent.** Re-ingesting the same chunk id replaces its vector
  in place (matching the knowledge node's idempotency claim) instead of
  duplicating the entry.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, cast, runtime_checkable

from deerflow.workflow.knowledge import (
    CITATION_PREFIX,
    DEFAULT_TOP_K,
    Chunk,
    Reranker,
    RetrievalRecord,
)


class EmbeddingError(ValueError):
    """Raised for an unusable embedder, or a malformed embedding answer."""


@runtime_checkable
class Embedder(Protocol):
    """A synchronous text embedder (the store never embeds off-thread)."""

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


@dataclass
class _Entry:
    chunk: Chunk
    vector: list[float]


def embeddings_from_callable(fn: Any) -> Embedder:
    """Adapt a plain ``fn(texts) -> vectors`` callable into an :class:`Embedder`.

    The simplest injection point for tests and for deployments whose embedder
    is a local function. A non-callable is rejected here (fail loud) rather
    than at the first query.
    """
    if not callable(fn):
        raise EmbeddingError("the injected embedder is not callable")
    embed_fn = cast(Callable[[list[str]], list[list[float]]], fn)

    class _CallableEmbedder:
        def embed(self, texts: Sequence[str]) -> list[list[float]]:
            return embed_fn(list(texts))

    return _CallableEmbedder()


def embeddings_from_langchain(embeddings: Any) -> Embedder:
    """Adapt a LangChain-style ``Embeddings`` object (``embed_documents``)."""

    class _LangChainEmbedder:
        def embed(self, texts: Sequence[str]) -> list[list[float]]:
            method = getattr(embeddings, "embed_documents", None)
            if method is None:
                raise EmbeddingError("the injected embeddings object has no embed_documents method")
            return [list(vector) for vector in method(list(texts))]

    return _LangChainEmbedder()


# ── Pure vector helpers ──────────────────────────────────────────────────────


def normalize_vector(vector: Sequence[float]) -> list[float]:
    """L2-normalize *vector*; a zero vector is returned unchanged.

    Normalizing at write time lets the query path use a plain dot product.
    """
    values = [float(component) for component in vector]
    norm = math.sqrt(sum(component * component for component in values))
    if norm == 0.0:
        return values
    return [component / norm for component in values]


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    """Cosine similarity, rounding to 6 decimals for a stable tie-break.

    Raises :class:`EmbeddingError` when the vectors have different dimensions
    — a dimension mismatch means the embedder changed under a populated store,
    which must be reported rather than scored as 0.
    """
    if len(left) != len(right):
        raise EmbeddingError(f"embedding dimension mismatch: {len(left)} != {len(right)}")
    if not left:
        raise EmbeddingError("embeddings must not be empty")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return round(dot / (left_norm * right_norm), 6)


def _coerce_vectors(raw: Any, *, expected: int) -> list[list[float]]:
    """Validate an embedder answer, or raise :class:`EmbeddingError`."""
    if raw is None:
        raise EmbeddingError("the embedder returned nothing")
    vectors = list(raw)
    if len(vectors) != expected:
        raise EmbeddingError(f"the embedder returned {len(vectors)} vectors for {expected} text(s)")
    coerced: list[list[float]] = []
    for index, vector in enumerate(vectors):
        try:
            coerced.append([float(component) for component in vector])
        except (TypeError, ValueError) as exc:
            raise EmbeddingError(f"embedding #{index} is not numeric: {exc}") from exc
    widths = {len(vector) for vector in coerced}
    if coerced and len(widths) != 1:
        raise EmbeddingError(f"the embedder returned ragged vectors: widths {sorted(widths)}")
    if coerced and not coerced[0]:
        raise EmbeddingError("the embedder returned zero-width vectors")
    return coerced


# ── Store ────────────────────────────────────────────────────────────────────


@dataclass
class VectorKnowledgeStore:
    """A :class:`KnowledgeStore` ranking by embedding cosine similarity.

    ``upsert`` embeds a chunk only when it does not already carry an
    ``embedding`` (so a caller that embedded upstream pays for it once) and
    replaces any existing entry with the same chunk id.  ``query`` embeds the
    query text, scores every stored chunk, drops non-positive scores when the
    query is non-empty (a negative/zero similarity is not a match), and orders
    ``(-score, citation)`` so ties are stable.
    """

    embedder: Embedder
    #: Normalize vectors at write/query time (recommended; enables dot-product speed).
    normalize: bool = True
    _data: dict[str, dict[str, _Entry]] = field(default_factory=dict)

    # -- writes ---------------------------------------------------------------

    def upsert(self, collection: str, chunks: list[Chunk]) -> int:
        """Embed (when needed) and store *chunks*; return how many were stored."""
        if not chunks:
            return 0
        pending = [chunk for chunk in chunks if chunk.embedding is None]
        embedded: list[list[float]] = []
        if pending:
            embedded = _coerce_vectors(self.embedder.embed([chunk.text for chunk in pending]), expected=len(pending))

        bucket = self._data.setdefault(collection, {})
        stored = 0
        cursor = 0
        for chunk in chunks:
            if chunk.embedding is None:
                vector = embedded[cursor]
                cursor += 1
                # Keep the caller's chunk object untouched (it may be reused).
                chunk = Chunk(id=chunk.id, doc_id=chunk.doc_id, text=chunk.text, source=chunk.source, ordinal=chunk.ordinal, embedding=vector)
            vector = [float(component) for component in (chunk.embedding or [])]
            if not vector:
                raise EmbeddingError(f"chunk {chunk.id!r} has an empty embedding")
            bucket[chunk.id] = _Entry(chunk=chunk, vector=normalize_vector(vector) if self.normalize else vector)
            stored += 1
        return stored

    # -- reads ----------------------------------------------------------------

    def query(self, collection: str, query: str, *, top_k: int = DEFAULT_TOP_K, reranker: Reranker | None = None) -> list[RetrievalRecord]:
        """Return at most *top_k* records ranked by similarity to *query*."""
        if top_k <= 0:
            return []
        bucket = self._data.get(collection, {})
        if not bucket:
            return []

        vector = self.embedder.embed([query])
        vector = _coerce_vectors(vector, expected=1)[0]
        query_vector = normalize_vector(vector) if self.normalize else vector

        records: list[RetrievalRecord] = []
        for entry in bucket.values():
            records.append(
                RetrievalRecord(
                    chunk_id=entry.chunk.id,
                    doc_id=entry.chunk.doc_id,
                    text=entry.chunk.text,
                    source=entry.chunk.source,
                    score=cosine_similarity(query_vector, entry.vector),
                    citation=f"{CITATION_PREFIX}{entry.chunk.id}",
                )
            )
        if query.strip():
            records = [record for record in records if record.score > 0]
        records.sort(key=lambda record: (-record.score, record.citation))
        if reranker is not None:
            try:
                records = list(reranker(query, records))
            except Exception:  # noqa: BLE001 — a reranker failure must not break retrieval
                pass
        return records[:top_k]

    # -- introspection --------------------------------------------------------

    def collections(self) -> list[str]:
        return list(self._data)

    def size(self, collection: str) -> int:
        return len(self._data.get(collection, {}))


__all__ = [
    "Embedder",
    "EmbeddingError",
    "VectorKnowledgeStore",
    "cosine_similarity",
    "embeddings_from_callable",
    "embeddings_from_langchain",
    "normalize_vector",
]
