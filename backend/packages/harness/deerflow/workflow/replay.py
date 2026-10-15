"""Deterministic record/replay for workflow runs (N14 §24.11).

A workflow mixes deterministic steps (``data``/``flow``) with calls that are not
reproducible (an LLM, an HTTP request, a local-software script).  Without a
recording there is no honest way to replay a run offline or to assert that a
change did not alter behaviour.

This module records each node's **observable result** — ``(inputs) → outputs``
keyed by a deterministic input digest — so a finished run can be replayed with no
model or external call at all.  The recording is at *node output* granularity
(the graph's only side-effect boundary); it makes the **graph** deterministic,
not the model's internal token stream.

Pure logic plus a small atomic JSON persistence helper (no model/network IO).
The compiler's node wrapper owns placement: it consults a :class:`ReplaySession`
placed on the run context under :data:`REPLAY_CONTEXT_KEY`.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Runtime-context key carrying the active :class:`ReplaySession`.
REPLAY_CONTEXT_KEY = "__replay_session"

REPLAY_SCHEMA_VERSION = 1

MODE_OFF = "off"
MODE_RECORD = "record"
MODE_REPLAY = "replay"

#: What to do on a replay miss: fail loud (default) or fall back to live execution.
MISS_ERROR = "error"
MISS_LIVE = "live"

_SECRET_KEY_HINTS = ("key", "token", "secret", "password", "passwd", "credential", "pwd", "authorization")


class ReplayError(ValueError):
    """Raised for a malformed fixture / session configuration."""


class ReplayMissError(RuntimeError):
    """Raised when a replay-mode node has no recorded result and ``on_miss='error'``."""


# ── Deterministic digests / redaction ────────────────────────────────────────


def _canonical(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, default=str, ensure_ascii=False)
    except (TypeError, ValueError):  # pragma: no cover — defensive
        return repr(value)


def input_digest(*, node_id: str, node_type: str, inputs: dict[str, Any]) -> str:
    """Deterministic digest of a node invocation (node identity + resolved inputs)."""
    payload = _canonical({"node": node_id, "type": node_type, "inputs": inputs})
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _is_secret_key(name: str, extra: frozenset[str]) -> bool:
    lowered = name.lower()
    if lowered in extra:
        return True
    return any(hint in lowered for hint in _SECRET_KEY_HINTS)


def redact_secrets(value: Any, *, extra_names: frozenset[str] | None = None) -> Any:
    """Recursively replace secret-looking mapping values with ``***``.

    A *redaction*, not a security boundary: it keeps obviously sensitive fields
    out of a fixture so a recording can be shared or committed.  Keys whose name
    hints at a credential (or is in *extra_names*, case-insensitive) are masked.
    """
    extra = frozenset(n.lower() for n in (extra_names or ()))

    def _walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {str(k): ("***" if _is_secret_key(str(k), extra) else _walk(v)) for k, v in node.items()}
        if isinstance(node, list):
            return [_walk(item) for item in node]
        return node

    return _walk(value)


# ── Fixture model ────────────────────────────────────────────────────────────


@dataclass
class ReplayEntry:
    """One recorded node result, keyed by its deterministic input digest."""

    node_id: str
    node_type: str
    inputs_digest: str
    outputs: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"node_id": self.node_id, "node_type": self.node_type, "inputs_digest": self.inputs_digest, "outputs": self.outputs}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ReplayEntry:
        try:
            return cls(
                node_id=str(data["node_id"]),
                node_type=str(data["node_type"]),
                inputs_digest=str(data["inputs_digest"]),
                outputs=dict(data["outputs"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ReplayError(f"malformed replay entry: {data!r}") from exc


@dataclass
class ReplayFixture:
    """A run's recorded node results (persistable as a single JSON document)."""

    run_id: str = ""
    entries: list[ReplayEntry] = field(default_factory=list)
    schema_version: int = REPLAY_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {"schema_version": self.schema_version, "run_id": self.run_id, "entries": [e.to_dict() for e in self.entries]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ReplayFixture:
        if not isinstance(data, dict):
            raise ReplayError("replay fixture must be a JSON object")
        version = data.get("schema_version", REPLAY_SCHEMA_VERSION)
        if version != REPLAY_SCHEMA_VERSION:
            raise ReplayError(f"unsupported replay schema_version {version!r} (expected {REPLAY_SCHEMA_VERSION})")
        entries = data.get("entries", [])
        if not isinstance(entries, list):
            raise ReplayError("replay fixture 'entries' must be a list")
        return cls(run_id=str(data.get("run_id", "")), entries=[ReplayEntry.from_dict(e) for e in entries])

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    @classmethod
    def from_json(cls, text: str) -> ReplayFixture:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ReplayError(f"replay fixture is not valid JSON: {exc}") from exc
        return cls.from_dict(data)


def save_fixture(path: str | os.PathLike[str], fixture: ReplayFixture) -> Path:
    """Atomically write *fixture* as JSON (temp file + ``os.replace``)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=".replay-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(fixture.to_json())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return target


def load_fixture(path: str | os.PathLike[str]) -> ReplayFixture:
    return ReplayFixture.from_json(Path(path).read_text(encoding="utf-8"))


# ── Session ──────────────────────────────────────────────────────────────────


@dataclass
class ReplaySession:
    """Drives recording / replaying for one run.

    ``mode`` selects the behaviour; a caller places the session on the run
    context under :data:`REPLAY_CONTEXT_KEY` and the compiler's node wrapper does
    the rest.  In ``replay`` mode a hit returns the recorded outputs and the
    executor is skipped; a miss follows ``on_miss`` (``error`` → raise, ``live``
    → execute normally).
    """

    mode: str = MODE_RECORD
    fixture: ReplayFixture = field(default_factory=ReplayFixture)
    on_miss: str = MISS_ERROR
    redact: bool = True
    redact_names: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if self.mode not in (MODE_RECORD, MODE_REPLAY):
            raise ReplayError(f"replay mode must be '{MODE_RECORD}' or '{MODE_REPLAY}', got {self.mode!r}")
        if self.on_miss not in (MISS_ERROR, MISS_LIVE):
            raise ReplayError(f"replay on_miss must be '{MISS_ERROR}' or '{MISS_LIVE}', got {self.on_miss!r}")
        self._index: dict[tuple[str, str], ReplayEntry] = {(e.node_id, e.inputs_digest): e for e in self.fixture.entries}

    def replay(self, *, node_id: str, node_type: str, inputs: dict[str, Any]) -> dict[str, Any] | None:
        """Return the recorded outputs, or ``None`` when a ``live`` miss allows execution."""
        entry = self._index.get((node_id, input_digest(node_id=node_id, node_type=node_type, inputs=inputs)))
        if entry is not None:
            return dict(entry.outputs)
        if self.on_miss == MISS_LIVE:
            return None
        raise ReplayMissError(f"node '{node_id}' has no recorded replay entry for the given inputs")

    def record(self, *, node_id: str, node_type: str, inputs: dict[str, Any], outputs: dict[str, Any]) -> ReplayEntry:
        """Append a recorded result (redacted when configured)."""
        stored = redact_secrets(outputs, extra_names=self.redact_names) if self.redact else dict(outputs)
        entry = ReplayEntry(
            node_id=node_id,
            node_type=node_type,
            inputs_digest=input_digest(node_id=node_id, node_type=node_type, inputs=inputs),
            outputs=stored,
        )
        self.fixture.entries.append(entry)
        self._index[(node_id, entry.inputs_digest)] = entry
        return entry
