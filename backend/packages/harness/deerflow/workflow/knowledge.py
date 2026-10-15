"""Local knowledge retrieval for AI workflow nodes (N14 §24.2).

"Giving the AI node the right context" is the core of process automation, but
retrieval currently lives scattered in skills/tools.  §24.2 wants it to be a
first-class, contract-shaped capability: ingest → index → retrieve → cite.

This module is the pure + local core:

- :func:`chunk_text` — deterministic, overlap-aware chunking;
- :func:`rank_chunks` — a deterministic keyword-overlap (BM25-lite) ranker that
  returns :class:`RetrievalRecord`s carrying a stable **citation** id, so a
  downstream prompt can reference where a fragment came from;
- a tiny :class:`KnowledgeStore` protocol (``upsert`` / ``query``) with an
  :class:`InMemoryKnowledgeStore` reference implementation;
- :func:`format_retrieval_block` — renders the hits as a budgeted ``<context>``
  block (the same already-sanitized tag :mod:`deerflow.workflow.context_policy`
  uses, so no new framework tag is introduced).

Embeddings and vector backends are *pluggable*: a store may score however it
wants, and an optional ``reranker`` callable can reorder the hits before the
``top_k`` cut.  The default is deterministic and dependency-free so an AI node
can retrieve offline; production vector stores are adapters behind the protocol.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from deerflow.workflow.context_policy import estimate_tokens

#: Runtime-context key carrying the knowledge store adapter.
KNOWLEDGE_STORE_CONTEXT_KEY = "knowledge_store"

#: Citation id prefix (stable, model-visible reference).
CITATION_PREFIX = "cite:"

DEFAULT_CHUNK_SIZE = 800
DEFAULT_CHUNK_OVERLAP = 100
DEFAULT_TOP_K = 5
MAX_TOP_K = 20

_ALLOWED_KEYS = frozenset({"collection", "query", "top_k", "ctx_budget", "rerank"})
_TOKEN_RE = re.compile(r"[0-9a-zA-Z_]+|[\u4e00-\u9fff]")
_TEMPLATE_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")

#: An optional reranker: ``(query, records) -> records``.
Reranker = Callable[[str, list["RetrievalRecord"]], list["RetrievalRecord"]]


class KnowledgeError(ValueError):
    """Raised for a malformed ``params.retrieval`` or an unusable chunk config."""


@dataclass
class Document:
    id: str
    text: str
    source: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Chunk:
    id: str
    doc_id: str
    text: str
    source: str = ""
    ordinal: int = 0
    embedding: list[float] | None = None


@dataclass
class RetrievalRecord:
    chunk_id: str
    doc_id: str
    text: str
    source: str = ""
    score: float = 0.0
    citation: str = ""


@dataclass
class RetrievalPolicy:
    collection: str
    query: str | None = None
    top_k: int = DEFAULT_TOP_K
    ctx_budget: int | None = None
    rerank: bool = False


# ── Chunking ─────────────────────────────────────────────────────────────────


def chunk_text(text: str, *, size: int = DEFAULT_CHUNK_SIZE, overlap: int = DEFAULT_CHUNK_OVERLAP) -> list[str]:
    """Split *text* into deterministic overlapping windows.

    Paragraphs are preferred split points, but a window never exceeds *size*
    characters; ``overlap`` characters are repeated at the start of the next
    window so a hit spanning a boundary is not lost.  Empty text → ``[]``.
    """
    if size <= 0:
        raise KnowledgeError("chunk size must be a positive integer")
    if overlap < 0 or overlap >= size:
        raise KnowledgeError("chunk overlap must be in [0, size)")

    text = text or ""
    if not text.strip():
        return []
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    start = 0
    step = size - overlap
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start += step
    return chunks


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens; each CJK character is its own token."""
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def _score(query_tokens: list[str], text: str) -> float:
    """BM25-lite score: fraction of distinct query terms present, weighted by count."""
    if not query_tokens:
        return 0.0
    text_tokens = tokenize(text)
    if not text_tokens:
        return 0.0
    counts: dict[str, int] = {}
    for token in text_tokens:
        counts[token] = counts.get(token, 0) + 1
    distinct = set(query_tokens)
    hits = sum(1 for term in distinct if term in counts)
    if hits == 0:
        return 0.0
    coverage = hits / len(distinct)
    frequency = sum(counts.get(term, 0) for term in distinct) / len(text_tokens)
    return round(coverage + frequency, 6)


# ── Ranking ──────────────────────────────────────────────────────────────────


def rank_chunks(chunks: list[Chunk], query: str, *, top_k: int = DEFAULT_TOP_K, reranker: Reranker | None = None) -> list[RetrievalRecord]:
    """Score + sort chunks deterministically; return at most *top_k* records.

    Ordering is ``(-score, citation)`` so ties are stable.  When *query* is
    empty every chunk scores 0 and the natural (insertion) order is preserved.
    """
    if top_k <= 0:
        return []
    query_tokens = tokenize(query)
    records = [
        RetrievalRecord(
            chunk_id=chunk.id,
            doc_id=chunk.doc_id,
            text=chunk.text,
            source=chunk.source,
            score=_score(query_tokens, chunk.text),
            citation=f"{CITATION_PREFIX}{chunk.id}",
        )
        for chunk in chunks
    ]
    if query_tokens:
        records = [r for r in records if r.score > 0]
    records.sort(key=lambda r: (-r.score, r.citation))
    if reranker is not None:
        try:
            records = list(reranker(query, records))
        except Exception:  # noqa: BLE001 — a reranker failure must not break retrieval
            pass
    return records[:top_k]


# ── Store ────────────────────────────────────────────────────────────────────


@runtime_checkable
class KnowledgeStore(Protocol):
    """A retrieval backend.  ``query`` may return an awaitable (executor awaits)."""

    def upsert(self, collection: str, chunks: list[Chunk]) -> Any: ...

    def query(self, collection: str, query: str, *, top_k: int = DEFAULT_TOP_K, reranker: Reranker | None = None) -> Any: ...


class InMemoryKnowledgeStore:
    """Reference store: deterministic keyword ranking, no embeddings."""

    def __init__(self) -> None:
        self._data: dict[str, list[Chunk]] = {}

    def upsert(self, collection: str, chunks: list[Chunk]) -> None:
        self._data.setdefault(collection, []).extend(chunks)

    def query(self, collection: str, query: str, *, top_k: int = DEFAULT_TOP_K, reranker: Reranker | None = None) -> list[RetrievalRecord]:
        return rank_chunks(self._data.get(collection, []), query, top_k=top_k, reranker=reranker)

    def collections(self) -> list[str]:
        return list(self._data)


def ingest_document(store: KnowledgeStore, *, collection: str, document: Document, size: int = DEFAULT_CHUNK_SIZE, overlap: int = DEFAULT_CHUNK_OVERLAP) -> list[Chunk]:
    """Chunk *document* and upsert it; return the chunks (sync stores only)."""
    chunks = [Chunk(id=f"{document.id}#{i}", doc_id=document.id, text=piece, source=document.source, ordinal=i) for i, piece in enumerate(chunk_text(document.text, size=size, overlap=overlap))]
    if chunks:
        result = store.upsert(collection, chunks)
        if inspect.isawaitable(result):  # pragma: no cover — async store must await itself
            raise KnowledgeError("knowledge store returned an awaitable; use an async ingestion path")
    return chunks


# ── Parameters / formatting ──────────────────────────────────────────────────


def parse_retrieval_params(params: dict | None) -> RetrievalPolicy | None:
    """Parse ``params.retrieval`` into a :class:`RetrievalPolicy`, or ``None``."""
    raw = (params or {}).get("retrieval")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise KnowledgeError("params.retrieval must be an object")
    unknown = set(raw) - _ALLOWED_KEYS
    if unknown:
        raise KnowledgeError(f"params.retrieval has unknown keys {sorted(unknown)}; allowed: {sorted(_ALLOWED_KEYS)}")

    collection = raw.get("collection")
    if not isinstance(collection, str) or not collection.strip():
        raise KnowledgeError("params.retrieval.collection must be a non-empty string")

    query = raw.get("query")
    if query is not None and not isinstance(query, str):
        raise KnowledgeError("params.retrieval.query must be a string")

    top_k = raw.get("top_k", DEFAULT_TOP_K)
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= MAX_TOP_K:
        raise KnowledgeError(f"params.retrieval.top_k must be an integer in 1..{MAX_TOP_K}")

    ctx_budget = raw.get("ctx_budget")
    if ctx_budget is not None and (isinstance(ctx_budget, bool) or not isinstance(ctx_budget, int) or ctx_budget <= 0):
        raise KnowledgeError("params.retrieval.ctx_budget must be a positive integer")

    rerank = raw.get("rerank", False)
    if not isinstance(rerank, bool):
        raise KnowledgeError("params.retrieval.rerank must be a boolean")

    return RetrievalPolicy(collection=collection, query=query, top_k=top_k, ctx_budget=ctx_budget, rerank=rerank)


def render_query(template: str | None, inputs: dict[str, Any], *, default: str = "") -> str:
    """Render a ``{{port}}`` retrieval query template (missing → empty)."""
    if not template:
        return default
    return _TEMPLATE_RE.sub(lambda m: "" if inputs.get(m.group(1)) is None else str(inputs.get(m.group(1))), template)


def format_retrieval_block(records: list[RetrievalRecord], *, budget: int | None = None) -> str:
    """Render hits as a budgeted ``<context>`` block with citation headers.

    Deterministic: records stay in ranked order; an item that would exceed the
    budget stops the fill.  No records → empty string.
    """
    kept: list[str] = []
    used = 0
    for record in records:
        text = (record.text or "").strip()
        if not text:
            continue
        header = f"--- {record.citation} {record.source or record.doc_id} ---"
        cost = estimate_tokens(header) + estimate_tokens(text)
        if budget is not None and used + cost > budget:
            break
        kept.append(f"{header}\n{text}")
        used += cost
    if not kept:
        return ""
    return "<context>\n" + "\n\n".join(kept) + "\n</context>"


async def aquery(store: KnowledgeStore, policy: RetrievalPolicy, *, query: str, reranker: Reranker | None = None) -> list[RetrievalRecord]:
    """Query the store, awaiting an async backend."""
    result = store.query(policy.collection, query, top_k=policy.top_k, reranker=reranker if policy.rerank else None)
    if inspect.isawaitable(result):
        result = await result
    return list(result or [])
