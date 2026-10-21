"""``data:knowledge`` node executor — local knowledge ingest / retrieve (N14 §24.2).

Two operations on a :class:`~deerflow.workflow.knowledge.KnowledgeStore` resolved
from ``runtime.context["knowledge_store"]``:

- ``retrieve`` (default): read ``params.collection`` for the query (``params.query``
  template over inputs, else the ``in`` input) and emit the ranked hits on
  ``records`` (each carrying a stable ``citation``) plus the concatenated text on
  ``out``.
- ``ingest``: chunk the document on the ``in`` input (or ``params.text``) and
  upsert it into the collection; emit the chunk records and the chunk count.

A node that asks to retrieve/ingest with **no store** in the run context fails
loudly — a node that explicitly declares knowledge work must not silently no-op.
"""

from __future__ import annotations

from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import WorkflowExecutionError
from deerflow.workflow.knowledge import (
    KNOWLEDGE_STORE_CONTEXT_KEY,
    Document,
    KnowledgeError,
    aquery,
    ingest_document,
    parse_retrieval_params,
    render_query,
)
from deerflow.workflow.resource_access import ResourceAccess, knowledge_write_access

OP_RETRIEVE = "retrieve"
OP_INGEST = "ingest"


def _record_to_dict(record: Any) -> dict[str, Any]:
    return {"citation": record.citation, "text": record.text, "source": record.source, "doc_id": record.doc_id, "chunk_id": record.chunk_id, "score": record.score}


def _require_collection(params: dict[str, Any]) -> str:
    collection = params.get("collection")
    if not isinstance(collection, str) or not collection.strip():
        raise WorkflowExecutionError("data:knowledge: missing required param 'collection'")
    return collection


def knowledge_resource_access(runtime: WorkflowRuntime, params: dict[str, Any], _inputs: dict[str, Any]) -> tuple[ResourceAccess, ...]:
    """Ingest locks the collection; retrieve does not block other readers."""
    operation = params.get("operation", OP_RETRIEVE)
    if operation != OP_INGEST:
        return ()
    collection = params.get("collection")
    if not isinstance(collection, str) or not collection.strip():
        return ()
    return (knowledge_write_access(collection.strip()),)


async def exec_knowledge(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Execute a ``data:knowledge`` node (``params.operation`` = retrieve | ingest)."""
    operation = params.get("operation", OP_RETRIEVE)
    if operation not in (OP_RETRIEVE, OP_INGEST):
        raise WorkflowExecutionError(f"data:knowledge: unknown operation {operation!r}; expected {OP_RETRIEVE!r} or {OP_INGEST!r}")

    collection = _require_collection(params)

    store = runtime.context.get(KNOWLEDGE_STORE_CONTEXT_KEY)
    if store is None:
        raise WorkflowExecutionError("data:knowledge: no knowledge_store in runtime context (inject one to use this node)")

    if operation == OP_INGEST:
        text = params.get("text")
        if text is None:
            text = inputs.get("in")
        if text is None:
            raise WorkflowExecutionError("data:knowledge: ingest requires a document on the 'in' input or params.text")
        doc_id = params.get("doc_id")
        if not isinstance(doc_id, str) or not doc_id.strip():
            raise WorkflowExecutionError("data:knowledge: ingest requires a non-empty 'doc_id' param")
        source = params.get("source") or ""
        chunks = ingest_document(store, collection=collection, document=Document(id=doc_id, text=str(text), source=str(source)))
        records = [{"citation": f"cite:{c.id}", "text": c.text, "source": c.source, "chunk_id": c.id, "doc_id": c.doc_id, "score": 0.0} for c in chunks]
        return {"out": len(chunks), "records": records}

    # retrieve
    try:
        policy = parse_retrieval_params(params) or parse_retrieval_params({"retrieval": {"collection": collection}})
    except KnowledgeError as exc:
        raise WorkflowExecutionError(f"data:knowledge: invalid retrieval params: {exc}") from exc
    assert policy is not None  # collection is present → policy parses

    default_query = inputs.get("in")
    query = render_query(params.get("query"), inputs, default="" if default_query is None else str(default_query))
    records = await aquery(store, policy, query=query)
    as_dicts = [_record_to_dict(r) for r in records]
    out_text = "\n\n".join(f"{r.citation}\n{r.text}" for r in records)
    return {"out": out_text, "records": as_dicts}
