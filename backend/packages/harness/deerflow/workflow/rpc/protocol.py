"""Wire protocol for the headless workflow engine.

The engine speaks line-delimited JSON-RPC 2.0 over stdio: one UTF-8 JSON object
per line, no batch requests, no HTTP framing.  The DSH plugin is its only
client; the contract is documented in ``docs/dsh-plugin-plan.md`` (§3.3, §8).

Two error layers are kept apart on purpose:

- transport/JSON-RPC failures use the reserved ``-32xxx`` codes;
- engine failures use :data:`ENGINE_ERROR` with a stable ``data.code`` string,
  so the plugin can branch on ``invalid-definition`` or ``unknown-run`` without
  parsing human-readable messages.
"""

from __future__ import annotations

import json
from typing import Any

#: Bumped whenever the request/response shapes below change incompatibly.
PROTOCOL_VERSION = 1

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
#: Engine-level failure; ``error.data.code`` carries the stable reason.
ENGINE_ERROR = -32000


class RpcError(Exception):
    """A failure that becomes a JSON-RPC ``error`` object."""

    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_error(self) -> dict[str, Any]:
        """Render the ``error`` member of a JSON-RPC response."""
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            error["data"] = self.data
        return error


class EngineError(RpcError):
    """An expected engine failure carrying a stable machine-readable code."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        payload = {"code": code, **(data or {})}
        super().__init__(ENGINE_ERROR, message, payload)
        self.engine_code = code


class InvalidParams(RpcError):
    """A request whose ``params`` do not satisfy the method contract."""

    def __init__(self, message: str, data: Any | None = None) -> None:
        super().__init__(INVALID_PARAMS, message, data)


def encode(message: dict[str, Any]) -> str:
    """Serialize one JSON-RPC message as a single line (newline included)."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"


def decode(line: str) -> dict[str, Any]:
    """Parse one request line.

    A malformed line is a caller bug, so it raises :class:`RpcError` with
    :data:`PARSE_ERROR` rather than being skipped silently.
    """
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RpcError(PARSE_ERROR, f"invalid JSON: {exc.msg}") from exc
    if not isinstance(message, dict):
        raise RpcError(INVALID_REQUEST, "request must be a JSON object")
    return message


__all__ = [
    "ENGINE_ERROR",
    "INTERNAL_ERROR",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "PARSE_ERROR",
    "PROTOCOL_VERSION",
    "EngineError",
    "InvalidParams",
    "RpcError",
    "decode",
    "encode",
]
